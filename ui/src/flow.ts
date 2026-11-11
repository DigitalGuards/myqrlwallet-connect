// Framework-free helpers for dApp flows that run on top of a wallet prompt.
// No DOM rendering and no framework: the dApp owns its state and its clock and
// calls these controllers whenever either changes.

/** Default time a step may wait before it is left to its button: ten minutes. */
export const DEFAULT_AUTO_START_EXPIRY_MS = 600_000;

/** Default time a sent transaction keeps its own step's button disabled: three minutes. */
export const DEFAULT_SENT_TRANSACTION_HOLD_MS = 180_000;

/**
 * One step of a dApp flow that could open the wallet by itself.
 * The dApp lists every step that is actionable for the user right now.
 */
export interface StepAutoStartCandidate {
  /** Step key. A step starts automatically at most once per key for the life of the controller. */
  readonly key: string;
  /**
   * The value `busy` takes while this step's own action runs. When `busy` equals it,
   * the user started the step by hand and it is never started automatically afterwards.
   */
  readonly busyKey: string;
  /** The step's action, the same function its button calls. */
  readonly run: () => void;
  /**
   * The step cannot start right now (wallet not connected, wrong account, own
   * transaction still awaited). It keeps its place and starts once this clears.
   */
  readonly blocked: boolean;
  /** Milliseconds the step must have been actionable before it starts by itself. 0 starts at once. */
  readonly holdMs: number;
}

/** Everything the controller needs to know, passed on every {@link StepAutoStart.update}. */
export interface StepAutoStartUpdate {
  /**
   * The user's steps that are actionable apart from `blocked` and `busy`.
   * Leave destructive or irreversible actions (refund, discard, release) out of this list.
   */
  readonly candidates: readonly StepAutoStartCandidate[];
  /**
   * Chain or server state has settled, so this reading can serve as a baseline.
   * Readings with `ready: false` are ignored.
   */
  readonly ready: boolean;
  /** The key of the action that is running, or null when nothing is. */
  readonly busy: string | null;
  /** The dApp's clock in milliseconds (for example `Date.now()`). */
  readonly now: number;
}

/** Options for {@link createStepAutoStart}. */
export interface StepAutoStartOptions {
  /**
   * The flow was created in this page session (the user just started it). Its first
   * `ready` reading counts as a transition, so a step that is already actionable
   * starts at once. Leave it unset for a flow opened from a link.
   */
  readonly fresh?: boolean;
  /** Milliseconds after which a waiting step is left to its button. Default 600 000. */
  readonly expiryMs?: number;
  /** Called with the keys inside their hold window whenever that set changes. */
  readonly onHolding?: (keys: readonly string[]) => void;
  /**
   * Whether the page is in the foreground. Default: `document.visibilityState === "visible"
   * && document.hasFocus()`. Replace it in tests.
   */
  readonly isForeground?: () => boolean;
  /**
   * A live clock in the same unit and timebase as the `now` passed to `update`.
   * When the page returns to the foreground the controller reads it to judge hold
   * and expiry, because a backgrounded page may not have called `update` for a
   * long time. Default `Date.now`. Replace it in tests, or when `now` is not epoch
   * milliseconds.
   */
  readonly clock?: () => number;
}

/** The controller returned by {@link createStepAutoStart}. */
export interface StepAutoStart {
  /**
   * Report the dApp's current state. Call it whenever that state changes and from
   * the dApp's own tick, so hold windows and expiry advance. A due step starts
   * during this call, at most one per call. Mark the step busy before or inside its
   * `run` (so `busy` is no longer null), otherwise an `update` made from inside `run`
   * cannot start a second step in the same turn but the next tick can.
   */
  update(input: StepAutoStartUpdate): void;
  /** Keys of the steps inside their hold window as of the last `update` (or foreground return). */
  holding(): readonly string[];
  /** Remove the foreground listeners. Later `update` calls do nothing. */
  dispose(): void;
}

function defaultForeground(): boolean {
  return (
    typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus()
  );
}

/**
 * Opens the wallet by itself, once, when a step of the user's turns actionable.
 *
 * The step's button stays the retry: a step is never started twice, a step the user
 * started by hand is never started afterwards, and a step that was already actionable on
 * the first `ready` reading is only a baseline (opening a link must never open a wallet).
 * A step that turns actionable waits its `holdMs`, then runs while nothing is busy, the
 * candidate is not blocked and the page is in the foreground. When the page returns to
 * the foreground a due step runs. A step that waited longer than `expiryMs` is left to
 * its button. There are no timers inside: call `update` from the dApp's own tick.
 *
 * @example
 * const autoStart = createStepAutoStart({
 *   onHolding: (keys) => renderHoldHint(keys),
 * });
 * // Whenever state changes, and once a second while a step is held:
 * autoStart.update({
 *   candidates: [
 *     { key: 'lock', busyKey: 'lock', run: sendLock, blocked: !walletReady, holdMs: 0 },
 *   ],
 *   ready: chainStateLoaded,
 *   busy: currentBusyKey,
 *   now: Date.now(),
 * });
 * // On teardown:
 * autoStart.dispose();
 */
export function createStepAutoStart(options: StepAutoStartOptions = {}): StepAutoStart {
  const expiryMs = options.expiryMs ?? DEFAULT_AUTO_START_EXPIRY_MS;
  const isForeground = options.isForeground ?? defaultForeground;
  const fresh = options.fresh === true;
  const clock = options.clock ?? Date.now;

  let latest: StepAutoStartUpdate = { candidates: [], ready: false, busy: null, now: 0 };
  let previous: ReadonlySet<string> | null = null;
  const started = new Set<string>();
  /** Step key to the time it started waiting. */
  const waiting = new Map<string, number>();
  let reported = '';
  let disposed = false;
  let firing = false;

  const fire = (): void => {
    // One fire starts at most one step, also when `run` calls `update` itself.
    if (firing) return;
    const { candidates, busy, now } = latest;
    if (busy !== null || !isForeground()) return;
    const next = candidates.find((candidate) => {
      const since = waiting.get(candidate.key);
      return (
        since !== undefined &&
        !candidate.blocked &&
        now - since >= candidate.holdMs &&
        now - since <= expiryMs
      );
    });
    if (next === undefined) return;
    waiting.delete(next.key);
    started.add(next.key);
    firing = true;
    try {
      next.run();
    } finally {
      firing = false;
    }
  };

  const computeHolding = (): readonly string[] => {
    const { candidates, now } = latest;
    return candidates
      .filter((candidate) => {
        const since = waiting.get(candidate.key);
        return since !== undefined && candidate.holdMs > 0 && now - since < candidate.holdMs;
      })
      .map((candidate) => candidate.key);
  };

  const onForeground = (): void => {
    if (disposed) return;
    // A hidden page may not have ticked for a long time: judge by the live clock.
    const now = clock();
    latest = { ...latest, now };
    for (const [key, since] of waiting) {
      if (now - since > expiryMs) waiting.delete(key);
    }
    fire();
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onForeground);
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', onForeground);
  }

  return {
    update(input) {
      if (disposed) return;
      latest = input;
      const { candidates, ready, busy, now } = input;
      // A step the user started by hand is never started automatically afterwards.
      for (const candidate of candidates) {
        if (busy === candidate.busyKey) {
          started.add(candidate.key);
          waiting.delete(candidate.key);
        }
      }
      if (ready) {
        const current = new Set(candidates.map((candidate) => candidate.key));
        const before = previous ?? (fresh ? new Set<string>() : null);
        previous = current;
        if (before !== null) {
          for (const [key, since] of waiting) {
            if (!current.has(key) || now - since > expiryMs) waiting.delete(key);
          }
          for (const key of current) {
            if (!before.has(key) && !started.has(key) && !waiting.has(key)) {
              waiting.set(key, now);
            }
          }
          fire();
        }
      }
      const keys = computeHolding();
      const signature = keys.join(',');
      if (signature !== reported) {
        reported = signature;
        options.onHolding?.(keys);
      }
    },
    holding: computeHolding,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onForeground);
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', onForeground);
      }
    },
  };
}

/** A transaction hash a dApp recorded for a step. */
export interface SentTransaction {
  /** The `0x` plus 64 hex digits hash the wallet returned. */
  readonly hash: string;
  /** The dApp clock value (milliseconds) when it was recorded. */
  readonly at: number;
}

/** Options for {@link createSentTransactions}. */
export interface SentTransactionsOptions {
  /** Milliseconds a recorded transaction holds its step's button. Default 180 000. */
  readonly holdMs?: number;
}

/** The store returned by {@link createSentTransactions}. */
export interface SentTransactions {
  /**
   * Record the hash a wallet returned for a step's own transaction. A value that is not
   * `0x` plus 64 hex digits is ignored, because wallets differ in what they return. Returns
   * whether it was recorded. Recording again for the same key replaces the earlier entry.
   */
  record(key: string, hash: unknown, now: number): boolean;
  /** The recorded transaction for a step, for a link to the explorer, or undefined. */
  get(key: string): SentTransaction | undefined;
  /**
   * True for `holdMs` after the step's transaction was recorded: the step's button stays
   * disabled while its own transaction is awaited. After that a dropped transaction can
   * be retried. Call `clear` when the step is done or the receipt arrived.
   */
  isHeld(key: string, now: number): boolean;
  /** Forget a step's transaction. */
  clear(key: string): void;
}

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * Remembers the transaction each step sent, so the dApp can show a link to the pending
 * transaction and keep that step's button disabled while the transaction is awaited.
 * Without it a second click sends a duplicate before the first one is mined.
 *
 * @example
 * const sent = createSentTransactions({ holdMs: 180_000 });
 * const hash = await provider.request({ method: 'qrl_sendTransaction', params: [tx] });
 * sent.record('lock', hash, Date.now());
 * // In render:
 * const pending = sent.get('lock');
 * if (pending) showLink(`https://shorscan.com/tx/${pending.hash}`);
 * button.disabled = sent.isHeld('lock', Date.now());
 */
export function createSentTransactions(options: SentTransactionsOptions = {}): SentTransactions {
  const holdMs = options.holdMs ?? DEFAULT_SENT_TRANSACTION_HOLD_MS;
  const entries = new Map<string, SentTransaction>();
  return {
    record(key, hash, now) {
      if (typeof hash !== 'string' || !TX_HASH.test(hash)) return false;
      entries.set(key, { hash, at: now });
      return true;
    },
    get: (key) => entries.get(key),
    isHeld(key, now) {
      const entry = entries.get(key);
      return entry !== undefined && now - entry.at < holdMs;
    },
    clear(key) {
      entries.delete(key);
    },
  };
}
