import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSentTransactions,
  createStepAutoStart,
  type StepAutoStartCandidate,
  type StepAutoStartOptions,
} from '../src/flow.js';

const HASH = `0x${'ab'.repeat(32)}`;

interface Harness {
  readonly runs: string[];
  readonly candidate: (
    key: string,
    extra?: Partial<StepAutoStartCandidate>
  ) => StepAutoStartCandidate;
}

function harness(): Harness {
  const runs: string[] = [];
  return {
    runs,
    candidate: (key, extra = {}) => ({
      key,
      busyKey: key,
      run: () => {
        runs.push(key);
      },
      blocked: false,
      holdMs: 0,
      ...extra,
    }),
  };
}

const view = { foreground: true };
const make = (options: StepAutoStartOptions = {}) =>
  createStepAutoStart({ isForeground: () => view.foreground, ...options });

afterEach(() => {
  view.foreground = true;
  vi.restoreAllMocks();
});

describe('createStepAutoStart', () => {
  it('treats the first ready reading as a baseline: nothing starts', () => {
    const h = harness();
    const controller = make();
    controller.update({ candidates: [h.candidate('a')], ready: true, busy: null, now: 0 });
    controller.update({ candidates: [h.candidate('a')], ready: true, busy: null, now: 20_000 });
    expect(h.runs).toEqual([]);
    controller.dispose();
  });

  it('takes no baseline from a reading that is not ready', () => {
    const h = harness();
    const controller = make();
    controller.update({ candidates: [h.candidate('a')], ready: false, busy: null, now: 0 });
    // The step settles later: that reading is still the baseline.
    controller.update({ candidates: [h.candidate('a')], ready: true, busy: null, now: 11_000 });
    expect(h.runs).toEqual([]);
    controller.dispose();
  });

  it('starts a step once it turns actionable after the baseline', () => {
    const h = harness();
    const controller = make();
    controller.update({ candidates: [], ready: true, busy: null, now: 0 });
    controller.update({ candidates: [h.candidate('a')], ready: true, busy: null, now: 100 });
    expect(h.runs).toEqual(['a']);
    controller.dispose();
  });

  it('counts the first reading as a transition when fresh', () => {
    const h = harness();
    const controller = make({ fresh: true });
    controller.update({ candidates: [h.candidate('a')], ready: true, busy: null, now: 0 });
    expect(h.runs).toEqual(['a']);
    controller.dispose();
  });

  it('does not count a not-ready reading as the fresh transition', () => {
    const h = harness();
    const controller = make({ fresh: true });
    controller.update({ candidates: [h.candidate('a')], ready: false, busy: null, now: 0 });
    expect(h.runs).toEqual([]);
    controller.update({ candidates: [h.candidate('a')], ready: true, busy: null, now: 10 });
    expect(h.runs).toEqual(['a']);
    controller.dispose();
  });

  it('starts a key at most once, also after it leaves and returns', () => {
    const h = harness();
    const controller = make();
    controller.update({ candidates: [], ready: true, busy: null, now: 0 });
    controller.update({ candidates: [h.candidate('a')], ready: true, busy: null, now: 1 });
    controller.update({ candidates: [h.candidate('a')], ready: true, busy: null, now: 20_000 });
    controller.update({ candidates: [], ready: true, busy: null, now: 21_000 });
    controller.update({ candidates: [h.candidate('a')], ready: true, busy: null, now: 22_000 });
    controller.update({ candidates: [h.candidate('a')], ready: true, busy: null, now: 40_000 });
    expect(h.runs).toEqual(['a']);
    controller.dispose();
  });

  it('never starts a step the user started by hand', () => {
    const h = harness();
    const controller = make();
    controller.update({ candidates: [], ready: true, busy: null, now: 0 });
    // Turns actionable while its own action is already running (a button press).
    controller.update({
      candidates: [h.candidate('a', { holdMs: 5_000 })],
      ready: true,
      busy: null,
      now: 1,
    });
    controller.update({
      candidates: [h.candidate('a', { holdMs: 5_000 })],
      ready: true,
      busy: 'a',
      now: 2,
    });
    controller.update({
      candidates: [h.candidate('a', { holdMs: 5_000 })],
      ready: true,
      busy: null,
      now: 60_000,
    });
    expect(h.runs).toEqual([]);
    controller.dispose();
  });

  it('does not start while something else is busy, then starts when it clears', () => {
    const h = harness();
    const controller = make();
    controller.update({ candidates: [], ready: true, busy: null, now: 0 });
    controller.update({ candidates: [h.candidate('a')], ready: true, busy: 'other', now: 1 });
    expect(h.runs).toEqual([]);
    controller.update({ candidates: [h.candidate('a')], ready: true, busy: null, now: 2 });
    expect(h.runs).toEqual(['a']);
    controller.dispose();
  });

  it('does not start a blocked step until it is no longer blocked', () => {
    const h = harness();
    const controller = make();
    controller.update({ candidates: [], ready: true, busy: null, now: 0 });
    controller.update({
      candidates: [h.candidate('a', { blocked: true })],
      ready: true,
      busy: null,
      now: 1,
    });
    controller.update({
      candidates: [h.candidate('a', { blocked: true })],
      ready: true,
      busy: null,
      now: 20_000,
    });
    expect(h.runs).toEqual([]);
    controller.update({ candidates: [h.candidate('a')], ready: true, busy: null, now: 20_001 });
    expect(h.runs).toEqual(['a']);
    controller.dispose();
  });

  it('holds a step for holdMs, reports it as holding, then starts it', () => {
    const h = harness();
    const seen: (readonly string[])[] = [];
    const controller = make({ onHolding: (keys) => seen.push(keys) });
    const held = (now: number): void => {
      controller.update({
        candidates: [h.candidate('claim', { holdMs: 180_000 })],
        ready: true,
        busy: null,
        now,
      });
    };
    controller.update({ candidates: [], ready: true, busy: null, now: 0 });
    held(1_000);
    expect(h.runs).toEqual([]);
    expect(controller.holding()).toEqual(['claim']);
    held(150_000);
    expect(h.runs).toEqual([]);
    held(180_999);
    expect(h.runs).toEqual([]);
    held(181_000);
    expect(h.runs).toEqual(['claim']);
    expect(controller.holding()).toEqual([]);
    // Reported once when it started holding and once when it stopped.
    expect(seen).toEqual([['claim'], []]);
    controller.dispose();
  });

  it('stops holding when the candidate disappears', () => {
    const h = harness();
    const seen: (readonly string[])[] = [];
    const controller = make({ onHolding: (keys) => seen.push(keys) });
    controller.update({ candidates: [], ready: true, busy: null, now: 0 });
    controller.update({
      candidates: [h.candidate('a', { holdMs: 10_000 })],
      ready: true,
      busy: null,
      now: 1,
    });
    controller.update({ candidates: [], ready: true, busy: null, now: 2 });
    expect(controller.holding()).toEqual([]);
    expect(seen).toEqual([['a'], []]);
    expect(h.runs).toEqual([]);
    controller.dispose();
  });

  it('leaves a step that waited longer than expiryMs to its button', () => {
    const h = harness();
    const controller = make();
    controller.update({ candidates: [], ready: true, busy: null, now: 0 });
    view.foreground = false;
    // In slices, as a dApp tick drives it.
    for (let now = 100; now <= 620_000; now += 10_000) {
      controller.update({ candidates: [h.candidate('a')], ready: true, busy: null, now });
    }
    view.foreground = true;
    controller.update({ candidates: [h.candidate('a')], ready: true, busy: null, now: 626_000 });
    expect(h.runs).toEqual([]);
    controller.dispose();
  });

  it('honors a custom expiryMs', () => {
    const h = harness();
    const controller = make({ expiryMs: 1_000 });
    controller.update({ candidates: [], ready: true, busy: null, now: 0 });
    view.foreground = false;
    controller.update({ candidates: [h.candidate('a')], ready: true, busy: null, now: 10 });
    view.foreground = true;
    controller.update({ candidates: [h.candidate('a')], ready: true, busy: null, now: 2_000 });
    expect(h.runs).toEqual([]);
    controller.dispose();
  });

  it('waits for the foreground and then starts once, on focus', () => {
    const h = harness();
    const controller = make();
    controller.update({ candidates: [], ready: true, busy: null, now: 0 });
    view.foreground = false;
    controller.update({ candidates: [h.candidate('a')], ready: true, busy: null, now: 100 });
    controller.update({ candidates: [h.candidate('a')], ready: true, busy: null, now: 20_000 });
    expect(h.runs).toEqual([]);
    view.foreground = true;
    window.dispatchEvent(new Event('focus'));
    expect(h.runs).toEqual(['a']);
    window.dispatchEvent(new Event('focus'));
    expect(h.runs).toEqual(['a']);
    controller.dispose();
  });

  it('starts a due step on visibilitychange', () => {
    const h = harness();
    const controller = make();
    controller.update({ candidates: [], ready: true, busy: null, now: 0 });
    view.foreground = false;
    controller.update({ candidates: [h.candidate('a')], ready: true, busy: null, now: 100 });
    view.foreground = true;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(h.runs).toEqual(['a']);
    controller.dispose();
  });

  it('keeps a held step waiting on a focus event before its hold has passed', () => {
    const h = harness();
    const controller = make();
    controller.update({ candidates: [], ready: true, busy: null, now: 0 });
    controller.update({
      candidates: [h.candidate('a', { holdMs: 5_000 })],
      ready: true,
      busy: null,
      now: 100,
    });
    window.dispatchEvent(new Event('focus'));
    expect(h.runs).toEqual([]);
    controller.dispose();
  });

  it('uses document visibility and focus by default', () => {
    const h = harness();
    let visible = false;
    vi.spyOn(document, 'hasFocus').mockImplementation(() => true);
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() =>
      visible ? 'visible' : 'hidden'
    );
    const controller = createStepAutoStart();
    controller.update({ candidates: [], ready: true, busy: null, now: 0 });
    controller.update({ candidates: [h.candidate('a')], ready: true, busy: null, now: 1 });
    expect(h.runs).toEqual([]);
    visible = true;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(h.runs).toEqual(['a']);
    controller.dispose();
  });

  it('starts one step at a time and the next one after the first is busy then idle', () => {
    const h = harness();
    const controller = make();
    controller.update({ candidates: [], ready: true, busy: null, now: 0 });
    const both = [h.candidate('a'), h.candidate('b')];
    controller.update({ candidates: both, ready: true, busy: null, now: 1 });
    expect(h.runs).toEqual(['a']);
    controller.update({ candidates: both, ready: true, busy: 'a', now: 2 });
    expect(h.runs).toEqual(['a']);
    controller.update({ candidates: both, ready: true, busy: null, now: 3 });
    expect(h.runs).toEqual(['a', 'b']);
    controller.dispose();
  });

  it('removes its listeners on dispose and ignores later updates', () => {
    const h = harness();
    const controller = make();
    controller.update({ candidates: [], ready: true, busy: null, now: 0 });
    view.foreground = false;
    controller.update({ candidates: [h.candidate('a')], ready: true, busy: null, now: 1 });
    controller.dispose();
    view.foreground = true;
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    controller.update({ candidates: [h.candidate('b')], ready: true, busy: null, now: 2 });
    expect(h.runs).toEqual([]);
  });

  it('removes the exact listeners it added', () => {
    const addDoc = vi.spyOn(document, 'addEventListener');
    const removeDoc = vi.spyOn(document, 'removeEventListener');
    const addWin = vi.spyOn(window, 'addEventListener');
    const removeWin = vi.spyOn(window, 'removeEventListener');
    const controller = make();
    controller.dispose();
    expect(removeDoc).toHaveBeenCalledWith('visibilitychange', addDoc.mock.calls[0]?.[1]);
    expect(removeWin).toHaveBeenCalledWith('focus', addWin.mock.calls[0]?.[1]);
  });
});

describe('createSentTransactions', () => {
  it('records a well-formed hash and returns it with the time', () => {
    const sent = createSentTransactions();
    expect(sent.record('lock', HASH, 1_000)).toBe(true);
    expect(sent.get('lock')).toEqual({ hash: HASH, at: 1_000 });
    expect(sent.get('other')).toBeUndefined();
  });

  it('ignores anything that is not 0x plus 64 hex digits', () => {
    const sent = createSentTransactions();
    for (const bad of [
      undefined,
      null,
      42,
      {},
      '',
      '0x',
      HASH.slice(0, -1),
      `${HASH}0`,
      `0x${'zz'.repeat(32)}`,
      HASH.slice(2),
      ` ${HASH}`,
    ]) {
      expect(sent.record('lock', bad, 1)).toBe(false);
    }
    expect(sent.get('lock')).toBeUndefined();
    expect(sent.isHeld('lock', 2)).toBe(false);
  });

  it('accepts upper-case hex', () => {
    const sent = createSentTransactions();
    expect(sent.record('k', `0x${'AB'.repeat(32)}`, 0)).toBe(true);
  });

  it('holds for holdMs (default 180 s) and releases afterwards', () => {
    const sent = createSentTransactions();
    sent.record('lock', HASH, 1_000);
    expect(sent.isHeld('lock', 1_000)).toBe(true);
    expect(sent.isHeld('lock', 180_999)).toBe(true);
    expect(sent.isHeld('lock', 181_000)).toBe(false);
    // The record stays readable for the explorer link.
    expect(sent.get('lock')?.hash).toBe(HASH);
  });

  it('honors a custom holdMs and keys are independent', () => {
    const sent = createSentTransactions({ holdMs: 500 });
    sent.record('a', HASH, 0);
    expect(sent.isHeld('a', 499)).toBe(true);
    expect(sent.isHeld('a', 500)).toBe(false);
    expect(sent.isHeld('b', 0)).toBe(false);
  });

  it('a later record replaces the earlier one and restarts the hold', () => {
    const sent = createSentTransactions({ holdMs: 100 });
    const second = `0x${'cd'.repeat(32)}`;
    sent.record('a', HASH, 0);
    sent.record('a', second, 90);
    expect(sent.get('a')).toEqual({ hash: second, at: 90 });
    expect(sent.isHeld('a', 150)).toBe(true);
  });

  it('clear forgets the transaction and ends the hold', () => {
    const sent = createSentTransactions();
    sent.record('a', HASH, 0);
    sent.clear('a');
    expect(sent.get('a')).toBeUndefined();
    expect(sent.isHeld('a', 1)).toBe(false);
  });
});
