import { afterEach, describe, expect, it, vi } from 'vitest';
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
        return this.probe?.promise ?? Promise.resolve(this.locked || !this.granted ? [] : accounts);
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

  it.each([false, true])('restores locked or ungranted intent (grant: %s)', async (granted) => {
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
    expect(provider.requests).toHaveLength(1);
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
      provider.emit('accountsChanged', accounts);
      provider.lock();
      provider.probe.resolve(accounts);
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
    await Promise.resolve();
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

  it('reflects extension-side revocation as locked or ungranted', async () => {
    const { provider, session } = setup();
    provider.locked = false;
    provider.granted = true;
    await session.connect();
    provider.granted = false;
    provider.emit('accountsChanged', []);
    expect(session.getState()).toMatchObject({ status: 'locked', accounts: [], intent: true });
    expect(provider.requests).toHaveLength(1);
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
});
