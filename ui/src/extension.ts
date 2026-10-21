/** The EIP-1193 events used by an extension session. */
export type ExtensionSessionEvent = 'accountsChanged' | 'chainChanged' | 'disconnect';

/** Structural EIP-1193 provider received through EIP-6963 discovery. */
export interface ExtensionSessionProvider {
  request(args: { method: string; params?: readonly unknown[] }): Promise<unknown>;
  on(event: ExtensionSessionEvent, listener: (value: unknown) => void): unknown;
  removeListener(event: ExtensionSessionEvent, listener: (value: unknown) => void): unknown;
}

export type ExtensionSessionStatus =
  | 'idle'
  | 'pending'
  | 'connected'
  | 'locked'
  | 'rejected'
  | 'error'
  | 'disconnecting'
  | 'disconnected';

export interface ExtensionSessionError {
  readonly operation: 'connect' | 'restore' | ExtensionSessionEvent;
  readonly code: number | null;
  readonly message: string;
  readonly cause: unknown;
}

/** Enable account actions only while status is connected. */
export interface ExtensionSessionState {
  readonly status: ExtensionSessionStatus;
  readonly accounts: readonly string[];
  /** Last chainChanged value, or null until one arrives. */
  readonly chainId: string | null;
  /** Whether account events may restore this connection. */
  readonly intent: boolean;
  readonly error: ExtensionSessionError | null;
}

export interface ExtensionSessionHandlers {
  onStateChange?: (state: ExtensionSessionState) => void;
  /** Optional additional check, such as the SDK's isCurrentQrlAddress checksum validator. */
  validateAccount?: (account: string) => boolean;
}

export interface ExtensionSession {
  readonly provider: ExtensionSessionProvider;
  getState(): ExtensionSessionState;
  /** Await the original approval request, including wallet unlock. */
  connect(): Promise<ExtensionSessionState>;
  /** Probe qrl_accounts; retain locked intent and quietly end an ungranted session. */
  restore(): Promise<ExtensionSessionState>;
  /** Explicit user disconnect: revoke the origin's grant and clean up locally. */
  disconnect(): Promise<ExtensionSessionState>;
  /** Terminal local teardown. An earlier disconnect's late-approval cleanup still runs. */
  dispose(): void;
}

function sessionError(
  cause: unknown,
  operation: ExtensionSessionError['operation']
): ExtensionSessionError {
  const value = typeof cause === 'object' && cause !== null ? cause : {};
  return {
    operation,
    code: 'code' in value && typeof value.code === 'number' ? value.code : null,
    message:
      'message' in value && typeof value.message === 'string'
        ? value.message
        : typeof cause === 'string'
          ? cause
          : 'Wallet request failed',
    cause,
  };
}

function readAccounts(
  value: unknown,
  validateAccount: ExtensionSessionHandlers['validateAccount']
): string[] {
  if (!Array.isArray(value)) throw new TypeError('Wallet returned an invalid account list');
  return Array.from(value, (account: unknown) => {
    if (
      typeof account !== 'string' ||
      account.length !== 129 ||
      !/^Q[\da-fA-F]{128}$/u.test(account) ||
      (validateAccount && !validateAccount(account))
    ) {
      throw new TypeError('Wallet returned an invalid account list');
    }
    return account;
  });
}

// A replacement helper for the same provider also expresses new Connect intent.
const connectIntents = new WeakMap<ExtensionSessionProvider, object>();
const revocations = new WeakMap<ExtensionSessionProvider, Promise<ExtensionSessionError | null>>();

interface AccountRequest {
  operation: 'connect' | 'restore';
  promise: Promise<ExtensionSessionState>;
  settle(): void;
}

/**
 * Framework-free extension lifecycle. Listeners precede every request or probe.
 * Empty accounts trigger a passive grant check. Only explicit disconnect intent
 * revokes permissions, including grants from a late approval. Provider errors
 * are reported in state, including disconnect errors after local cleanup.
 */
export function createExtensionSession(
  provider: ExtensionSessionProvider,
  handlers: ExtensionSessionHandlers = {}
): ExtensionSession {
  let state: ExtensionSessionState = Object.freeze({
    status: 'idle',
    accounts: Object.freeze([]),
    chainId: null,
    intent: false,
    error: null,
  });
  let generation = 0;
  let disposed = false;
  let unsubscribe: (() => void) | undefined;
  let flight: AccountRequest | undefined;
  let queued: AccountRequest | undefined;
  let closing: Promise<ExtensionSessionState> | undefined;
  const approvals = new Set<{ revokeAfter?: { intent: object; token: number } }>();

  function accountRequest(operation: AccountRequest['operation']): AccountRequest {
    let resolve: ((snapshot: ExtensionSessionState) => void) | undefined;
    const promise = new Promise<ExtensionSessionState>((done) => {
      resolve = done;
    });
    return { operation, promise, settle: () => resolve?.(state) };
  }

  function update(patch: Partial<ExtensionSessionState>): void {
    state = Object.freeze({
      ...state,
      ...patch,
      accounts: Object.freeze([...(patch.accounts ?? state.accounts)]),
    });
    if (!disposed) handlers.onStateChange?.(state);
  }

  function retire(patch?: Partial<ExtensionSessionState>): void {
    generation += 1;
    const pending = flight;
    const waiting = queued;
    flight = undefined;
    queued = undefined;
    const cleanup = unsubscribe;
    unsubscribe = undefined;
    cleanup?.();
    if (patch) update(patch);
    pending?.settle();
    waiting?.settle();
  }

  function current(token: number): boolean {
    return !disposed && token === generation;
  }

  function fail(cause: unknown, operation: ExtensionSessionError['operation']): void {
    const error = sessionError(cause, operation);
    retire({
      status: operation === 'connect' && error.code === 4001 ? 'rejected' : 'error',
      accounts: [],
      chainId: null,
      intent: false,
      error,
    });
  }

  function end(error: ExtensionSessionError | null = null): void {
    retire({ status: 'disconnected', accounts: [], chainId: null, intent: false, error });
  }

  function revoke(intent?: object): Promise<ExtensionSessionError | null> {
    const promise = Promise.resolve(revocations.get(provider)).then(async () => {
      if (intent && connectIntents.get(provider) !== intent) return null;
      try {
        await provider.request({
          method: 'wallet_revokePermissions',
          params: [{ qrl_accounts: {} }],
        });
        return null;
      } catch (cause) {
        const error = sessionError(cause, 'disconnect');
        return error.code === -32601 ? null : error;
      }
    });
    revocations.set(provider, promise);
    void promise.then(() => {
      if (revocations.get(provider) === promise) revocations.delete(provider);
    });
    return promise;
  }

  function start(operation: 'connect' | 'restore'): Promise<ExtensionSessionState> {
    if (disposed) return Promise.resolve(state);
    // A new request waits for revocation to finish, so its new grant survives.
    const revocation = closing ?? revocations.get(provider);
    if (revocation) {
      if (queued && (queued.operation === 'connect' || operation === 'restore'))
        return queued.promise;
      queued?.settle();
      const waiting = accountRequest(operation);
      queued = waiting;
      void revocation.then(async () => {
        if (queued !== waiting) return;
        queued = undefined;
        await start(operation);
        waiting.settle();
      });
      return waiting.promise;
    }
    if (flight && (flight.operation === 'connect' || operation === 'restore'))
      return flight.promise;
    retire();
    const token = generation;
    const request = accountRequest(operation);
    flight = request;
    let latestAccounts: string[] | undefined;
    let accountRevision = 0;
    let awaitingReply = true;

    function applyAccounts(accounts: readonly string[]): void {
      update({ status: accounts.length ? 'connected' : 'locked', accounts, error: null });
    }

    async function probeEmptyAccounts(revision: number): Promise<void> {
      try {
        const value = await provider.request({ method: 'qrl_accounts' });
        if (!current(token) || revision !== accountRevision) return;
        latestAccounts = readAccounts(value, handlers.validateAccount);
        if (operation !== 'connect' || !awaitingReply) applyAccounts(latestAccounts);
      } catch (cause) {
        if (!current(token) || revision !== accountRevision) return;
        if (sessionError(cause, 'accountsChanged').code === 4100) end();
        // Other probe failures leave the locked state and subscriptions intact.
      }
    }

    const accountsChanged = (value: unknown): void => {
      if (!current(token)) return;
      accountRevision += 1;
      try {
        latestAccounts = readAccounts(value, handlers.validateAccount);
      } catch (error) {
        fail(error, 'accountsChanged');
        return;
      }
      // Approval may emit accounts before its promise settles. Continue awaiting
      // that original request, and let the most recent event win over its reply.
      if (operation !== 'connect' || !awaitingReply) applyAccounts(latestAccounts);
      if (current(token) && latestAccounts.length === 0) void probeEmptyAccounts(accountRevision);
    };
    const chainChanged = (value: unknown): void => {
      if (!current(token)) return;
      if (typeof value !== 'string' || !/^0x[\da-f]+$/iu.test(value)) {
        fail(new TypeError('Wallet returned an invalid chain id'), 'chainChanged');
        return;
      }
      update({ chainId: value });
    };
    const disconnected = (value: unknown): void => {
      if (!current(token)) return;
      const error = sessionError(value, 'disconnect');
      if (error.code !== 1013) end(error);
    };
    unsubscribe = () => {
      provider.removeListener('accountsChanged', accountsChanged);
      provider.removeListener('chainChanged', chainChanged);
      provider.removeListener('disconnect', disconnected);
    };
    try {
      provider.on('accountsChanged', accountsChanged);
      provider.on('chainChanged', chainChanged);
      provider.on('disconnect', disconnected);
    } catch (error) {
      fail(error, operation);
      return request.promise;
    }

    void Promise.resolve().then(async () => {
      if (!current(token)) return;
      const approval: { revokeAfter?: { intent: object; token: number } } = {};
      if (operation === 'connect') approvals.add(approval);
      try {
        const value = await provider.request({
          method: operation === 'connect' ? 'qrl_requestAccounts' : 'qrl_accounts',
        });
        const cleanup = approval.revokeAfter;
        if (
          cleanup &&
          connectIntents.get(provider) === cleanup.intent &&
          Array.isArray(value) &&
          value.length
        ) {
          const error = await revoke(cleanup.intent);
          if (error && current(cleanup.token)) update({ error });
        }
        if (!current(token)) return;
        const accounts = latestAccounts ?? readAccounts(value, handlers.validateAccount);
        awaitingReply = false;
        flight = undefined;
        applyAccounts(accounts);
      } catch (error) {
        if (!current(token)) return;
        if (operation === 'restore' && accountRevision > 0) {
          // The account event already applied a newer state, including its probe.
          flight = undefined;
        } else if (operation === 'restore' && sessionError(error, operation).code === 4100) {
          end();
        } else {
          fail(error, operation);
        }
      } finally {
        approvals.delete(approval);
        request.settle();
      }
    });
    update({ status: 'pending', accounts: [], chainId: null, intent: true, error: null });
    return request.promise;
  }

  function disconnect(): Promise<ExtensionSessionState> {
    if (disposed) return Promise.resolve(state);
    if (closing) return closing;
    // Invalidate callbacks immediately, including events emitted by revocation.
    // Publish the disconnecting state after installing closing, so handlers can
    // safely queue another Connect or dispose the helper synchronously.
    const pending = flight;
    const waiting = queued;
    flight = undefined;
    queued = undefined;
    retire();
    const token = generation;
    const intent = connectIntents.get(provider);
    if (intent) for (const approval of approvals) approval.revokeAfter = { intent, token };
    const promise = revoke().then((error) => {
      closing = undefined;
      if (current(token)) update({ status: 'disconnected', error });
      return state;
    });
    closing = promise;
    update({ status: 'disconnecting', accounts: [], chainId: null, intent: false, error: null });
    pending?.settle();
    waiting?.settle();
    return promise;
  }

  return {
    provider,
    getState: () => state,
    connect: () => {
      if (!disposed) connectIntents.set(provider, {});
      return start('connect');
    },
    restore: () => start('restore'),
    disconnect,
    dispose: () => {
      disposed = true;
      end();
    },
  };
}
