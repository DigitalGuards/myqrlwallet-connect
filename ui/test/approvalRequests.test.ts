// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  createApprovalRequests,
  isApprovalMethod,
  trackedProvider,
} from '../src/approvalRequests.js';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: Error) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('approval requests', () => {
  it('is open from the send until the wallet answers', async () => {
    const approvals = createApprovalRequests();
    const seen: boolean[] = [];
    approvals.subscribe(() => seen.push(approvals.pending()));
    const wallet = deferred<string>();
    const sent = approvals.track(() => wallet.promise);
    expect(approvals.pending()).toBe(true);
    wallet.resolve('0xhash');
    expect(await sent).toBe('0xhash');
    expect(approvals.pending()).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  it('closes on a rejection and on a request that throws while being sent', async () => {
    const approvals = createApprovalRequests();
    const wallet = deferred<string>();
    const sent = approvals.track(() => wallet.promise);
    wallet.reject(new Error('User rejected the request.'));
    await expect(sent).rejects.toThrow('User rejected');
    expect(approvals.pending()).toBe(false);
    await expect(
      approvals.track(() => {
        throw new Error('wallet not connected');
      })
    ).rejects.toThrow('not connected');
    expect(approvals.pending()).toBe(false);
  });

  it('stays open until the last of several requests settles', async () => {
    const approvals = createApprovalRequests();
    const first = deferred<number>();
    const second = deferred<number>();
    const a = approvals.track(() => first.promise);
    const b = approvals.track(() => second.promise);
    first.resolve(1);
    await a;
    expect(approvals.pending()).toBe(true);
    second.resolve(2);
    await b;
    expect(approvals.pending()).toBe(false);
  });

  it('stops telling a listener that unsubscribed', async () => {
    const approvals = createApprovalRequests();
    const listener = vi.fn();
    const unsubscribe = approvals.subscribe(listener);
    unsubscribe();
    await approvals.track(() => Promise.resolve(1));
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('approval requests under stress', () => {
  it('tells listeners only when pending changes', async () => {
    const approvals = createApprovalRequests();
    const listener = vi.fn();
    approvals.subscribe(listener);
    const first = deferred<number>();
    const second = deferred<number>();
    const a = approvals.track(() => first.promise);
    const b = approvals.track(() => second.promise);
    expect(listener).toHaveBeenCalledTimes(1);
    first.resolve(1);
    await a;
    expect(listener).toHaveBeenCalledTimes(1);
    second.resolve(2);
    await b;
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('never loses the wallet answer or the count to a listener that throws', async () => {
    const approvals = createApprovalRequests();
    const after = vi.fn();
    approvals.subscribe(() => {
      throw new Error('broken listener');
    });
    approvals.subscribe(after);
    await expect(approvals.track(() => Promise.resolve('0xhash'))).resolves.toBe('0xhash');
    expect(approvals.pending()).toBe(false);
    expect(after).toHaveBeenCalledTimes(2);
  });

  it('forgets requests that were lost with the connection', async () => {
    const approvals = createApprovalRequests();
    const listener = vi.fn();
    approvals.subscribe(listener);
    const lost = deferred<string>();
    const sent = approvals.track(() => lost.promise);
    expect(approvals.pending()).toBe(true);
    approvals.reset();
    expect(approvals.pending()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
    // A request of the new connection counts on its own.
    const next = deferred<string>();
    const again = approvals.track(() => next.promise);
    // The lost one settling late must not close the new one.
    lost.resolve('late');
    await sent;
    expect(approvals.pending()).toBe(true);
    next.resolve('0xhash');
    await again;
    expect(approvals.pending()).toBe(false);
    // Nothing open: a reset is silent.
    approvals.reset();
    expect(listener).toHaveBeenCalledTimes(4);
  });
});

describe('trackedProvider', () => {
  it('is still the whole provider: events, flags and methods with their own this', async () => {
    class Wallet {
      readonly isTestWallet = true;
      #handlers = new Map<string, () => void>();
      request(args: { method: string }): Promise<unknown> {
        return Promise.resolve(`${args.method} from ${String(this.#handlers.size)}`);
      }
      on(event: string, handler: () => void): void {
        this.#handlers.set(event, handler);
      }
      listenerCount(): number {
        return this.#handlers.size;
      }
    }
    const wallet = new Wallet();
    const tracked = trackedProvider(wallet, createApprovalRequests());
    expect(tracked.isTestWallet).toBe(true);
    tracked.on('accountsChanged', () => undefined);
    expect(tracked.listenerCount()).toBe(1);
    expect(wallet.listenerCount()).toBe(1);
    expect(await tracked.request({ method: 'eth_chainId' })).toBe('eth_chainId from 1');
    expect(await tracked.request({ method: 'eth_sendTransaction' })).toBe(
      'eth_sendTransaction from 1'
    );
  });

  it('counts prompts and lets reads pass uncounted', async () => {
    const approvals = createApprovalRequests();
    const wallet = deferred<string>();
    const during: boolean[] = [];
    const provider = trackedProvider(
      {
        request: ({ method }) => {
          during.push(approvals.pending());
          return method === 'qrl_sendTransaction' ? wallet.promise : Promise.resolve('0x1');
        },
      },
      approvals
    );
    expect(await provider.request({ method: 'qrl_chainId' })).toBe('0x1');
    expect(await provider.request({ method: 'qrl_call', params: [] })).toBe('0x1');
    const sent = provider.request({ method: 'qrl_sendTransaction', params: [] });
    wallet.resolve('0xhash');
    await sent;
    expect(during).toEqual([false, false, true]);
    expect(approvals.pending()).toBe(false);
  });

  it('hands out the same function for a method every time and follows a replaced one', () => {
    const calls: string[] = [];
    const wallet = {
      request: (): Promise<unknown> => Promise.resolve(null),
      on: (): void => {
        calls.push('first');
      },
    };
    const tracked = trackedProvider(wallet, createApprovalRequests());
    expect(tracked.on).toBe(tracked.on);
    expect(tracked.request).toBe(tracked.request);
    tracked.on();
    // The provider swaps the method at runtime (a reconnect, a lazy init).
    wallet.on = (): void => {
      calls.push('second');
    };
    tracked.on();
    expect(calls).toEqual(['first', 'second']);
  });

  it('counts a frozen provider like any other', async () => {
    const approvals = createApprovalRequests();
    const during: boolean[] = [];
    const wallet = Object.freeze({
      isFrozenWallet: true,
      request: ({ method }: { method: string }): Promise<unknown> => {
        during.push(approvals.pending());
        return Promise.resolve(method);
      },
      on: (): void => undefined,
    });
    const tracked = trackedProvider(wallet, approvals);
    // Reading a locked property through a proxy that stood on the provider
    // itself would throw here.
    expect(typeof tracked.request).toBe('function');
    expect(typeof tracked.on).toBe('function');
    expect(tracked.isFrozenWallet).toBe(true);
    expect(await tracked.request({ method: 'eth_sendTransaction' })).toBe('eth_sendTransaction');
    expect(await tracked.request({ method: 'eth_chainId' })).toBe('eth_chainId');
    expect(during).toEqual([true, false]);
  });

  it('keeps private state working on a frozen class instance', () => {
    class FrozenWallet {
      #listeners = 0;
      readonly on: () => number;
      constructor() {
        // An own, unbound method that needs the real instance as `this`.
        this.on = function on(this: FrozenWallet): number {
          this.#listeners += 1;
          return this.#listeners;
        };
        Object.freeze(this);
      }
      request(): Promise<unknown> {
        return Promise.resolve(this.#listeners);
      }
    }
    const tracked = trackedProvider(new FrozenWallet(), createApprovalRequests());
    expect(tracked.on()).toBe(1);
    expect(tracked.on()).toBe(2);
    expect(tracked instanceof FrozenWallet).toBe(true);
  });

  it('works on a provider that is itself a proxy', async () => {
    const approvals = createApprovalRequests();
    const during: boolean[] = [];
    const inner = {
      request: ({ method }: { method: string }): Promise<unknown> => {
        during.push(approvals.pending());
        return Promise.resolve(method);
      },
      isWallet: true,
    };
    // The way some wallets guard their provider against deletion.
    const guarded = new Proxy(inner, { deleteProperty: () => true });
    const tracked = trackedProvider(guarded, approvals);
    expect(tracked.isWallet).toBe(true);
    expect('isWallet' in tracked).toBe(true);
    await tracked.request({ method: 'personal_sign' });
    expect(during).toEqual([true]);
  });

  it('writes a property through to the provider', () => {
    const wallet = { request: (): Promise<unknown> => Promise.resolve(null), label: 'a' };
    const tracked = trackedProvider(wallet, createApprovalRequests());
    tracked.label = 'b';
    expect(wallet.label).toBe('b');
    expect(tracked.label).toBe('b');
  });

  it('knows the prompting methods of both chains', () => {
    for (const method of [
      'eth_sendTransaction',
      'personal_sign',
      'eth_signTypedData_v4',
      'wallet_switchEthereumChain',
      'qrl_requestAccounts',
      'qrl_sendTransaction',
      'qrl_signMessage',
      'qrl_signTypedData',
      // Both spellings of the QRL chain methods, and batched calls.
      'wallet_switchQrlChain',
      'wallet_switchQRLChain',
      'wallet_addQRLChain',
      'wallet_sendCalls',
    ]) {
      expect(isApprovalMethod(method)).toBe(true);
    }
    // Method names are case-sensitive.
    expect(isApprovalMethod('wallet_switchqrlchain')).toBe(false);
    for (const method of [
      'eth_call',
      'eth_chainId',
      'eth_estimateGas',
      'qrl_call',
      'qrl_getBalance',
    ]) {
      expect(isApprovalMethod(method)).toBe(false);
    }
  });
});
