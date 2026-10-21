import { afterEach, describe, expect, it, vi } from 'vitest';
import { isCurrentQrlAddress, qip55AddressFromBytes } from '@qrlwallet/connect';
import {
  createExtensionSession,
  type ExtensionSessionEvent,
  type ExtensionSessionProvider,
  type ExtensionSessionState,
} from '../src/extension.js';

const accounts = [`Q${'a'.repeat(128)}`];
const otherAccounts = [`Q${'b'.repeat(128)}`];
const events: ExtensionSessionEvent[] = ['accountsChanged', 'chainChanged', 'disconnect'];

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((error: Error) => void) | undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    promise,
    resolve(value: T) {
      if (!resolve) throw new Error('Missing resolver');
      resolve(value);
    },
    reject(error: Error) {
      if (!reject) throw new Error('Missing rejecter');
      reject(error);
    },
  };
}

function rpcError(code: number, message = 'Wallet error') {
  return Object.assign(new Error(message), { code });
}

class MockProvider implements ExtensionSessionProvider {
  locked = true;
  granted = false;
  requests: { method: string; params?: readonly unknown[] }[] = [];
  subscriptionsAtRequest: number[][] = [];
  listeners = new Map<ExtensionSessionEvent, Set<(value: unknown) => void>>();
  approvals: ReturnType<typeof deferred<unknown>>[] = [];
  probe: ReturnType<typeof deferred<unknown>> | undefined;
  revocation: ReturnType<typeof deferred<unknown>> | undefined;
  revokeError: Error | undefined;

  on(event: ExtensionSessionEvent, listener: (value: unknown) => void) {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  removeListener(event: ExtensionSessionEvent, listener: (value: unknown) => void) {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: ExtensionSessionEvent, value: unknown) {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }

  request(args: { method: string; params?: readonly unknown[] }): Promise<unknown> {
    this.requests.push(args);
    this.subscriptionsAtRequest.push(events.map((event) => this.listeners.get(event)?.size ?? 0));
    switch (args.method) {
      case 'qrl_accounts':
        if (this.probe) return this.probe.promise;
        if (this.locked) return Promise.resolve([]);
        return this.granted ? Promise.resolve(accounts) : Promise.reject(rpcError(4100));
      case 'qrl_requestAccounts': {
        if (!this.locked && this.granted) return Promise.resolve(accounts);
        const approval = deferred<unknown>();
        this.approvals.push(approval);
        return approval.promise;
      }
      case 'wallet_revokePermissions':
        if (this.revokeError) return Promise.reject(this.revokeError);
        return (this.revocation?.promise ?? Promise.resolve(null)).then(() => {
          this.granted = false;
          this.emit('accountsChanged', []);
          return null;
        });
      default:
        return Promise.reject(rpcError(-32601));
    }
  }

  approve() {
    this.granted = true;
    this.emit('accountsChanged', accounts);
    this.approvals[this.approvals.length - 1]?.resolve(accounts);
  }

  lock() {
    this.locked = true;
    this.emit('accountsChanged', []);
  }
  unlock() {
    this.locked = false;
    if (this.granted) this.emit('accountsChanged', accounts);
  }
}

function setup() {
  const provider = new MockProvider();
  const states: ExtensionSessionState[] = [];
  const session = createExtensionSession(provider, {
    onStateChange: (state) => states.push(state),
  });
  return { provider, session, states };
}

afterEach(() => vi.useRealTimers());

// Drain provider callbacks without relying on an unresolved request to finish.
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function expectSettled(
  request: Promise<ExtensionSessionState>,
  snapshot: ExtensionSessionState
) {
  const result = await Promise.race([request, tick()]);
  expect(result).toEqual(snapshot);
}

describe('extension session', () => {
  it('subscribes first and awaits one original locked request through unlock and approval', async () => {
    const { provider, session, states } = setup();
    const request = session.connect();
    expect(session.connect()).toBe(request);
    expect(session.restore()).toBe(request);
    expect(session.getState()).toMatchObject({ status: 'pending', accounts: [], intent: true });
    await Promise.resolve();
    expect(provider.subscriptionsAtRequest).toEqual([[1, 1, 1]]);
    provider.unlock();
    expect(session.getState().status).toBe('pending');
    provider.approve();
    expect(session.getState().status).toBe('pending');
    expect(await request).toMatchObject({ status: 'connected', accounts });
    expect(provider.requests.map((r) => r.method)).toEqual(['qrl_requestAccounts']);
    expect(states.map((s) => s.status)).toEqual(['pending', 'connected']);
  });

  it('keeps awaiting approval when unlock exposes a previously granted account', async () => {
    const { provider, session } = setup();
    provider.granted = true;
    const request = session.connect();
    await Promise.resolve();
    provider.unlock();
    expect(session.getState()).toMatchObject({ status: 'pending', accounts: [] });
    provider.approve();
    expect((await request).status).toBe('connected');
  });

  it.each([false, true])('restores intent while locked (grant: %s)', async (granted) => {
    const { provider, session } = setup();
    provider.granted = granted;
    expect(await session.restore()).toMatchObject({ status: 'locked', accounts: [], intent: true });
    expect(provider.subscriptionsAtRequest).toEqual([[1, 1, 1]]);
    expect(session.provider).toBe(provider);
    provider.unlock();
    if (!granted) provider.approve();
    expect(session.getState()).toMatchObject({ status: 'connected', accounts, intent: true });
    expect(provider.requests.map((r) => r.method)).toEqual(['qrl_accounts']);
  });

  it('keeps subscriptions on lock, recovers on unlock and never revokes', async () => {
    const { provider, session } = setup();
    provider.locked = false;
    provider.granted = true;
    await session.connect();
    provider.lock();
    expect(session.getState()).toMatchObject({ status: 'locked', accounts: [], intent: true });
    expect(provider.granted).toBe(true);
    expect(events.map((event) => provider.listeners.get(event)?.size)).toEqual([1, 1, 1]);
    provider.unlock();
    expect(session.getState()).toMatchObject({ status: 'connected', accounts });
    await tick();
    expect(provider.requests.map((r) => r.method)).toEqual(['qrl_requestAccounts', 'qrl_accounts']);
  });

  it.each(['Dismissed', 'Approval timed out'])('reports 4001 as rejected: %s', async (message) => {
    vi.useFakeTimers();
    const { provider, session } = setup();
    const request = session.connect();
    await Promise.resolve();
    setTimeout(() => provider.approvals[0]?.reject(rpcError(4001, message)), 90_000);
    await vi.advanceTimersByTimeAsync(89_999);
    expect(session.getState().status).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(await request).toMatchObject({
      status: 'rejected',
      intent: false,
      accounts: [],
      error: { code: 4001, message, operation: 'connect' },
    });
    provider.unlock();
    provider.approve();
    expect(session.getState().status).toBe('rejected');
  });

  it('reports other request and probe errors distinctly', async () => {
    const { provider, session } = setup();
    const request = session.connect();
    await Promise.resolve();
    provider.approvals[0]?.reject(rpcError(4200));
    expect(await request).toMatchObject({
      status: 'error',
      error: { code: 4200, operation: 'connect' },
    });
    provider.probe = deferred<unknown>();
    const restore = session.restore();
    provider.probe.reject(rpcError(4900));
    expect(await restore).toMatchObject({
      status: 'error',
      error: { code: 4900, operation: 'restore' },
    });
  });

  it.each([false, true])(
    'revokes only on explicit disconnect, including while locked (%s)',
    async (locked) => {
      const { provider, session } = setup();
      provider.granted = true;
      provider.locked = locked;
      await session.restore();
      expect(await session.disconnect()).toMatchObject({
        status: 'disconnected',
        accounts: [],
        intent: false,
        error: null,
      });
      expect(provider.requests[provider.requests.length - 1]).toEqual({
        method: 'wallet_revokePermissions',
        params: [{ qrl_accounts: {} }],
      });
      expect(provider.granted).toBe(false);
      expect(events.map((event) => provider.listeners.get(event)?.size)).toEqual([0, 0, 0]);
    }
  );

  it.each([-32601, 4200, 4001])(
    'cleans up on revoke error %s with only -32601 treated as unsupported',
    async (code) => {
      const { provider, session } = setup();
      await session.restore();
      provider.revokeError = rpcError(code);
      const result = await session.disconnect();
      expect(result).toMatchObject({ status: 'disconnected', accounts: [], intent: false });
      expect(result.error?.code ?? null).toBe(code === -32601 ? null : code);
      expect(events.map((event) => provider.listeners.get(event)?.size)).toEqual([0, 0, 0]);
    }
  );

  it('ignores captured events and pending replies after disconnect and a new connect', async () => {
    const { provider, session, states } = setup();
    const oldRequest = session.connect();
    await Promise.resolve();
    const oldListeners = events.map((event) => [...(provider.listeners.get(event) ?? [])]);
    await session.disconnect();
    const disconnectedState = session.getState();
    oldListeners[0]?.forEach((listener) => {
      listener(accounts);
    });
    oldListeners[1]?.forEach((listener) => {
      listener('0x2');
    });
    oldListeners[2]?.forEach((listener) => {
      listener(rpcError(4900));
    });
    expect(session.getState()).toBe(disconnectedState);
    const newRequest = session.connect();
    await Promise.resolve();
    oldListeners[0]?.forEach((listener) => {
      listener(otherAccounts);
    });
    oldListeners[1]?.forEach((listener) => {
      listener('0x3');
    });
    oldListeners[2]?.forEach((listener) => {
      listener(rpcError(4900));
    });
    provider.approvals[0]?.resolve(otherAccounts);
    await oldRequest;
    expect(session.getState()).toMatchObject({ status: 'pending', accounts: [], chainId: null });
    provider.unlock();
    provider.approve();
    expect(await newRequest).toMatchObject({ status: 'connected', accounts });
    expect(states.filter((state) => state.status === 'connected')).toHaveLength(1);
    expect(events.map((event) => provider.listeners.get(event)?.size)).toEqual([1, 1, 1]);
  });

  it('supersedes a slow restore with connect and ignores the old probe and listeners', async () => {
    const { provider, session } = setup();
    provider.probe = deferred<unknown>();
    const restore = session.restore();
    await Promise.resolve();
    const old = [...(provider.listeners.get('accountsChanged') ?? [])];
    const connect = session.connect();
    await Promise.resolve();
    old.forEach((listener) => {
      listener(otherAccounts);
    });
    provider.probe.resolve(otherAccounts);
    await restore;
    expect(session.getState().status).toBe('pending');
    provider.approve();
    expect(await connect).toMatchObject({ status: 'connected', accounts });
  });

  it.each(['connect', 'restore'] as const)(
    'newer account events win over a stale %s reply',
    async (operation) => {
      const { provider, session } = setup();
      provider.probe = deferred<unknown>();
      const request = session[operation]();
      await Promise.resolve();
      const originalProbe = provider.probe;
      provider.probe = deferred<unknown>();
      provider.emit('accountsChanged', accounts);
      provider.lock();
      originalProbe.resolve(accounts);
      provider.probe.resolve([]);
      provider.approvals[0]?.resolve(accounts);
      expect(await request).toMatchObject({ status: 'locked', accounts: [], intent: true });
      provider.granted = true;
      provider.unlock();
      expect(session.getState().status).toBe('connected');
    }
  );

  it('keeps an unlock event that races a locked restore response', async () => {
    const { provider, session } = setup();
    provider.probe = deferred<unknown>();
    const request = session.restore();
    await Promise.resolve();
    provider.emit('accountsChanged', accounts);
    provider.probe.resolve([]);
    expect(await request).toMatchObject({ status: 'connected', accounts });
  });

  it('coalesces disconnect and serializes a new connect after revocation', async () => {
    const { provider, session } = setup();
    await session.restore();
    provider.revocation = deferred<unknown>();
    const disconnect = session.disconnect();
    expect(session.disconnect()).toBe(disconnect);
    const connect = session.connect();
    await tick();
    expect(session.getState()).toMatchObject({
      status: 'disconnecting',
      accounts: [],
      intent: false,
    });
    expect(provider.requests.map((r) => r.method)).toEqual([
      'qrl_accounts',
      'wallet_revokePermissions',
    ]);
    provider.revocation.resolve(null);
    await disconnect;
    await Promise.resolve();
    provider.unlock();
    provider.approve();
    expect(await connect).toMatchObject({ status: 'connected', accounts });
    expect(provider.granted).toBe(true);
  });

  it('reports chain changes and provider disconnect, with no revoke', async () => {
    const { provider, session } = setup();
    await session.restore();
    provider.emit('chainChanged', '0x301825');
    expect(session.getState().chainId).toBe('0x301825');
    provider.emit('disconnect', rpcError(4900, 'Provider offline'));
    expect(session.getState()).toMatchObject({
      status: 'disconnected',
      intent: false,
      accounts: [],
      error: { code: 4900 },
    });
    provider.approve();
    expect(session.getState().status).toBe('disconnected');
    expect(provider.requests).toHaveLength(1);
  });

  it('ends quietly when an unlocked wallet removes the grant', async () => {
    const { provider, session } = setup();
    provider.locked = false;
    provider.granted = true;
    await session.connect();
    provider.granted = false;
    provider.emit('accountsChanged', []);
    await tick();
    expect(session.getState()).toMatchObject({
      status: 'disconnected',
      accounts: [],
      intent: false,
      error: null,
    });
    expect(provider.requests.map((r) => r.method)).toEqual(['qrl_requestAccounts', 'qrl_accounts']);
    expect(events.map((event) => provider.listeners.get(event)?.size)).toEqual([0, 0, 0]);
  });

  it('disposes locally and ignores late results and subsequent operations', async () => {
    const { provider, session, states } = setup();
    const request = session.connect();
    await Promise.resolve();
    session.dispose();
    session.dispose();
    provider.approve();
    await request;
    await session.connect();
    await session.restore();
    await session.disconnect();
    expect(states.map((s) => s.status)).toEqual(['pending']);
    expect(provider.requests).toHaveLength(1);
    expect(session.getState()).toMatchObject({ status: 'disconnected', intent: false });
    expect(events.map((event) => provider.listeners.get(event)?.size)).toEqual([0, 0, 0]);
  });

  it('validates account payloads and exposes immutable copies', async () => {
    const { provider, session } = setup();
    await session.restore();
    const delivered = [...accounts];
    provider.emit('accountsChanged', delivered);
    delivered.length = 0;
    expect(session.getState().accounts).toEqual(accounts);
    expect(Object.isFrozen(session.getState())).toBe(true);
    expect(Object.isFrozen(session.getState().accounts)).toBe(true);
    provider.emit('accountsChanged', [42]);
    expect(session.getState()).toMatchObject({ status: 'error', accounts: [], intent: false });
  });

  it('rejects sparse account arrays from a request', async () => {
    const { provider, session } = setup();
    const request = session.connect();
    await Promise.resolve();
    provider.approvals[0]?.resolve(new Array<unknown>(1));
    expect(await request).toMatchObject({ status: 'error', accounts: [], intent: false });
  });

  it.each([false, true])(
    'revokes a late approval after Disconnect (disposed: %s)',
    async (dispose) => {
      const { provider, session, states } = setup();
      const request = session.connect();
      await tick();
      const closing = session.disconnect();
      await expectSettled(request, session.getState());
      await expectSettled(closing, { ...session.getState(), status: 'disconnected' });
      if (dispose) session.dispose();
      provider.unlock();
      provider.approve();
      await tick();
      expect(provider.granted).toBe(false);
      expect(provider.requests.map((r) => r.method)).toEqual([
        'qrl_requestAccounts',
        'wallet_revokePermissions',
        'wallet_revokePermissions',
      ]);
      expect(session.getState()).toMatchObject({ status: 'disconnected', intent: false });
      expect(states.some((state) => state.status === 'connected')).toBe(false);
    }
  );

  it.each(['same session', 'replacement session', 'during revocation'] as const)(
    'preserves a new Connect after Disconnect: %s',
    async (mode) => {
      const { provider, session } = setup();
      void session.connect();
      await tick();
      if (mode === 'during revocation') provider.revocation = deferred<unknown>();
      const closing = session.disconnect();
      if (mode !== 'during revocation') await closing;
      const next = mode === 'replacement session' ? createExtensionSession(provider) : session;
      if (next !== session) session.dispose();
      const request = next.connect();
      provider.unlock();
      provider.approve();
      await tick();
      expect(provider.requests.filter((r) => r.method === 'wallet_revokePermissions')).toHaveLength(
        1
      );
      provider.revocation?.resolve(null);
      await closing;
      await tick();
      provider.approve();
      expect(await request).toMatchObject({ status: 'connected', accounts });
      expect(provider.granted).toBe(true);
      next.dispose();
    }
  );

  it.each(['empty', 'rejected'] as const)(
    'skips late revocation for an %s approval',
    async (reply) => {
      const { provider, session } = setup();
      void session.connect();
      await tick();
      await session.disconnect();
      if (reply === 'empty') provider.approvals[0]?.resolve([]);
      else provider.approvals[0]?.reject(rpcError(4001));
      await tick();
      expect(provider.requests.filter((r) => r.method === 'wallet_revokePermissions')).toHaveLength(
        1
      );
      expect(session.getState().status).toBe('disconnected');
    }
  );

  it('contains a failed late revocation without restoring accounts', async () => {
    const { provider, session } = setup();
    void session.connect();
    await tick();
    await session.disconnect();
    provider.revokeError = rpcError(4200);
    provider.approve();
    await tick();
    expect(session.getState()).toMatchObject({
      status: 'disconnected',
      accounts: [],
      intent: false,
    });
    expect(provider.requests.filter((r) => r.method === 'wallet_revokePermissions')).toHaveLength(
      2
    );
  });

  it.each([false, true])(
    'waits for late revocation before Connect (replacement: %s)',
    async (replacement) => {
      const { provider, session } = setup();
      void session.connect();
      await tick();
      await session.disconnect();
      provider.revocation = deferred<unknown>();
      provider.unlock();
      provider.approve();
      await tick();
      const next = replacement ? createExtensionSession(provider) : session;
      if (replacement) session.dispose();
      const request = next.connect();
      await tick();
      expect(provider.requests.filter((r) => r.method === 'qrl_requestAccounts')).toHaveLength(1);
      provider.revocation.resolve(null);
      await tick();
      provider.approve();
      expect(await request).toMatchObject({ status: 'connected', accounts });
      expect(provider.granted).toBe(true);
      next.dispose();
    }
  );

  it('serializes an immediate replacement Connect after the first revocation', async () => {
    const { provider, session } = setup();
    provider.locked = false;
    provider.granted = true;
    await session.connect();
    provider.revocation = deferred<unknown>();
    const closing = session.disconnect();
    session.dispose();
    const replacement = createExtensionSession(provider);
    const request = replacement.connect();
    await tick();
    expect(provider.requests.filter((r) => r.method === 'qrl_requestAccounts')).toHaveLength(1);
    provider.revocation.resolve(null);
    await closing;
    await tick();
    provider.approve();
    expect(await request).toMatchObject({ status: 'connected', accounts });
    expect(replacement.getState().status).toBe('connected');
    expect(provider.granted).toBe(true);
    replacement.dispose();
  });

  it('restores an unlocked grant and quietly disconnects an ungranted origin', async () => {
    const { provider, session } = setup();
    provider.locked = false;
    expect(await session.restore()).toMatchObject({
      status: 'disconnected',
      accounts: [],
      intent: false,
      error: null,
    });
    expect(events.map((event) => provider.listeners.get(event)?.size)).toEqual([0, 0, 0]);
    provider.granted = true;
    expect(await session.restore()).toMatchObject({ status: 'connected', accounts, intent: true });
  });

  it('recovers accounts from the probe after an empty account event', async () => {
    const { provider, session } = setup();
    provider.locked = false;
    provider.granted = true;
    await session.connect();
    provider.emit('accountsChanged', []);
    expect(session.getState().status).toBe('locked');
    await tick();
    expect(session.getState()).toMatchObject({ status: 'connected', accounts, intent: true });
  });

  it.each(['locked', 'error', 'invalid accounts'] as const)(
    'keeps intent and listeners after an empty-event probe returns %s',
    async (reply) => {
      const { provider, session } = setup();
      await session.restore();
      provider.probe = deferred<unknown>();
      provider.emit('accountsChanged', []);
      if (reply === 'error') provider.probe.reject(rpcError(4900));
      else provider.probe.resolve(reply === 'locked' ? [] : ['invalid']);
      await tick();
      expect(session.getState()).toMatchObject({
        status: 'locked',
        accounts: [],
        intent: true,
        error: null,
      });
      expect(events.map((event) => provider.listeners.get(event)?.size)).toEqual([1, 1, 1]);
      expect(provider.requests.every((r) => r.method === 'qrl_accounts')).toBe(true);
    }
  );

  it.each(['restore', 'empty event'] as const)(
    'keeps a newer account event over an older rejected %s probe',
    async (source) => {
      const { provider, session } = setup();
      if (source === 'empty event') await session.restore();
      provider.probe = deferred<unknown>();
      const request = source === 'restore' ? session.restore() : undefined;
      if (source === 'empty event') provider.emit('accountsChanged', []);
      await tick();
      provider.emit('accountsChanged', accounts);
      provider.probe.reject(rpcError(4100));
      await request;
      await tick();
      expect(session.getState()).toMatchObject({
        status: 'connected',
        accounts,
        intent: true,
        error: null,
      });
      expect(events.map((event) => provider.listeners.get(event)?.size)).toEqual([1, 1, 1]);
    }
  );

  it.each(['accounts', 'locked', '4100'] as const)(
    'ignores an old empty-event probe returning %s after a newer lock event',
    async (reply) => {
      const { provider, session } = setup();
      await session.restore();
      const old = deferred<unknown>();
      provider.probe = old;
      provider.emit('accountsChanged', []);
      await tick();
      provider.probe = deferred<unknown>();
      provider.emit('accountsChanged', []);
      provider.probe.resolve([]);
      if (reply === '4100') old.reject(rpcError(4100));
      else old.resolve(reply === 'accounts' ? accounts : []);
      await tick();
      expect(session.getState()).toMatchObject({ status: 'locked', accounts: [], intent: true });
    }
  );

  it('ignores a locked probe answer after a newer unlock event', async () => {
    const { provider, session } = setup();
    await session.restore();
    provider.probe = deferred<unknown>();
    provider.emit('accountsChanged', []);
    await tick();
    provider.emit('accountsChanged', accounts);
    provider.probe.resolve([]);
    await tick();
    expect(session.getState()).toMatchObject({ status: 'connected', accounts });
  });

  for (const operation of ['connect', 'restore'] as const) {
    it.each(['disconnect', 'provider', 'accountsChanged', 'chainChanged', 'dispose'] as const)(
      `settles a pending ${operation} on %s while its provider stays silent`,
      async (teardown) => {
        const { provider, session } = setup();
        provider.probe = deferred<unknown>();
        const request = session[operation]();
        await tick();
        let close: Promise<ExtensionSessionState> | undefined;
        if (teardown === 'disconnect') close = session.disconnect();
        else if (teardown === 'dispose') session.dispose();
        else if (teardown === 'provider') provider.emit('disconnect', rpcError(1011));
        else provider.emit(teardown, teardown === 'accountsChanged' ? [1] : 'invalid');
        await expectSettled(request, session.getState());
        await close;
        expect(events.map((event) => provider.listeners.get(event)?.size)).toEqual([0, 0, 0]);
      }
    );
  }

  it('settles a superseded restore before its provider replies', async () => {
    const { provider, session } = setup();
    provider.probe = deferred<unknown>();
    const restore = session.restore();
    await tick();
    const snapshot = session.getState();
    void session.connect();
    await expectSettled(restore, snapshot);
    session.dispose();
  });

  it.each(['connect', 'restore'] as const)(
    'settles pending %s when an empty-event probe detects a removed grant',
    async (operation) => {
      const { provider, session } = setup();
      provider.probe = deferred<unknown>();
      const request = session[operation]();
      await tick();
      provider.probe = deferred<unknown>();
      provider.emit('accountsChanged', []);
      provider.probe.reject(rpcError(4100));
      await tick();
      await expectSettled(request, session.getState());
      expect(session.getState()).toMatchObject({
        status: 'disconnected',
        intent: false,
        error: null,
      });
    }
  );

  it('handles a synchronous provider disconnect inside a request', async () => {
    const { provider, session } = setup();
    vi.spyOn(provider, 'request').mockImplementation(() => {
      provider.emit('disconnect', rpcError(1011));
      return deferred<unknown>().promise;
    });
    const request = session.connect();
    await tick();
    await expectSettled(request, session.getState());
    expect(session.getState().status).toBe('disconnected');
    expect(events.map((event) => provider.listeners.get(event)?.size)).toEqual([0, 0, 0]);
  });

  it('allows synchronous disposal from the pending handler before sending a request', async () => {
    const provider = new MockProvider();
    const session = createExtensionSession(provider, {
      onStateChange: () => {
        session.dispose();
      },
    });
    expect((await session.connect()).status).toBe('disconnected');
    expect(provider.requests).toHaveLength(0);
    expect(events.map((event) => provider.listeners.get(event)?.size)).toEqual([0, 0, 0]);
  });

  it.each(['connect', 'restore'] as const)(
    'settles a queued %s on dispose before revocation answers',
    async (operation) => {
      const { provider, session } = setup();
      await session.restore();
      provider.revocation = deferred<unknown>();
      const closing = session.disconnect();
      const request = session[operation]();
      session.dispose();
      await expectSettled(request, session.getState());
      provider.revocation.resolve(null);
      await closing;
      await tick();
      expect(provider.requests.map((r) => r.method)).toEqual([
        'qrl_accounts',
        'wallet_revokePermissions',
      ]);
    }
  );

  it('coalesces connects queued during revocation', async () => {
    const { provider, session } = setup();
    provider.locked = false;
    provider.granted = true;
    await session.connect();
    provider.revocation = deferred<unknown>();
    const closing = session.disconnect();
    const first = session.connect();
    const second = session.connect();
    await tick();
    expect(provider.requests.map((r) => r.method)).toEqual([
      'qrl_requestAccounts',
      'wallet_revokePermissions',
    ]);
    provider.revocation.resolve(null);
    await closing;
    await tick();
    provider.approve();
    expect((await first).status).toBe('connected');
    expect(await second).toEqual(await first);
    expect(provider.requests.filter((r) => r.method === 'qrl_requestAccounts')).toHaveLength(2);
  });

  it('handles synchronous account events and repeated Connect during a request', async () => {
    const { provider, session } = setup();
    const request = vi.spyOn(provider, 'request').mockImplementation(({ method }) => {
      if (method === 'qrl_accounts') return Promise.resolve([]);
      provider.emit('accountsChanged', otherAccounts);
      provider.emit('accountsChanged', []);
      return Promise.resolve(accounts);
    });
    const first = session.connect();
    expect(session.connect()).toBe(first);
    expect(session.restore()).toBe(first);
    expect((await first).status).toBe('locked');
    expect(
      request.mock.calls.filter(([args]) => args.method === 'qrl_requestAccounts')
    ).toHaveLength(1);
  });

  it('normalizes synchronous request and revocation failures', async () => {
    const { provider, session } = setup();
    vi.spyOn(provider, 'request').mockImplementation(() => {
      throw rpcError(4200);
    });
    expect(await session.connect()).toMatchObject({ status: 'error', error: { code: 4200 } });
    expect(await session.disconnect()).toMatchObject({
      status: 'disconnected',
      error: { code: 4200 },
    });
    expect(events.map((event) => provider.listeners.get(event)?.size)).toEqual([0, 0, 0]);
  });

  it('keeps lock, validation failure and disposal local', async () => {
    const { provider, session } = setup();
    await session.restore();
    provider.lock();
    provider.emit('chainChanged', 'invalid');
    session.dispose();
    await tick();
    expect(provider.requests.every((r) => r.method === 'qrl_accounts')).toBe(true);
  });

  for (const source of ['connect', 'restore', 'event'] as const) {
    it.each([
      ' ',
      '',
      'Qabc',
      `q${'a'.repeat(128)}`,
      `Q${'a'.repeat(40)}`,
      `Q${'g'.repeat(128)}`,
      `Q${'a'.repeat(129)}`,
      `${accounts[0]}\n`,
    ])(`rejects malformed QRL text from ${source}: %s`, async (account) => {
      const { provider, session } = setup();
      if (source === 'event') {
        await session.restore();
        provider.emit('accountsChanged', [account]);
      } else {
        vi.spyOn(provider, 'request').mockResolvedValue([account]);
        await session[source]();
      }
      expect(session.getState()).toMatchObject({ status: 'error', accounts: [], intent: false });
    });
  }

  it('accepts upper, lower and mixed hex bodies with the default text validator', async () => {
    const { provider, session } = setup();
    const values = [accounts[0], `Q${'A'.repeat(128)}`, `Q${'aB'.repeat(64)}`];
    vi.spyOn(provider, 'request').mockResolvedValue(values);
    expect(await session.connect()).toMatchObject({ status: 'connected', accounts: values });
  });

  it.each(['connect', 'restore', 'event', 'empty-event probe'] as const)(
    'accepts the SDK checksum validator and checks every account from %s',
    async (source) => {
      const provider = new MockProvider();
      const session = createExtensionSession(provider, { validateAccount: isCurrentQrlAddress });
      const checksummed = qip55AddressFromBytes(new Uint8Array(64).fill(0xab));
      const badChecksum = checksummed.replace(/[a-f]/giu, (c) =>
        c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()
      );
      expect(isCurrentQrlAddress(badChecksum)).toBe(false);
      vi.spyOn(provider, 'request').mockResolvedValue([checksummed]);
      expect((await session.restore()).status).toBe('connected');
      if (source === 'event') provider.emit('accountsChanged', [checksummed, badChecksum]);
      else {
        vi.spyOn(provider, 'request').mockResolvedValue([checksummed, badChecksum]);
        if (source === 'empty-event probe') provider.emit('accountsChanged', []);
        else await session[source]();
      }
      await tick();
      expect(session.getState()).toMatchObject({
        status: source === 'empty-event probe' ? 'locked' : 'error',
        accounts: [],
      });
    }
  );

  it.each(['pending', 'locked', 'connected'] as const)(
    'preserves %s state and subscriptions on recoverable disconnect 1013',
    async (status) => {
      const { provider, session } = setup();
      if (status === 'connected') {
        provider.locked = false;
        provider.granted = true;
      }
      const request = status === 'locked' ? session.restore() : session.connect();
      await tick();
      const snapshot = session.getState();
      expect(snapshot.status).toBe(status);
      provider.emit('disconnect', rpcError(1013));
      expect(session.getState()).toBe(snapshot);
      expect(events.map((event) => provider.listeners.get(event)?.size)).toEqual([1, 1, 1]);
      provider.unlock();
      provider.approve();
      await request;
      expect(session.getState().status).toBe('connected');
      expect(provider.requests.some((r) => r.method === 'wallet_revokePermissions')).toBe(false);
    }
  );

  it.each([1011, 4900, undefined])('ends a session on provider disconnect %s', async (code) => {
    const { provider, session } = setup();
    await session.restore();
    provider.emit('disconnect', code === undefined ? undefined : rpcError(code));
    expect(session.getState()).toMatchObject({
      status: 'disconnected',
      accounts: [],
      intent: false,
    });
    expect(events.map((event) => provider.listeners.get(event)?.size)).toEqual([0, 0, 0]);
    expect(provider.requests).toHaveLength(1);
  });
});
