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

describe('trackedProvider', () => {
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
    ]) {
      expect(isApprovalMethod(method)).toBe(true);
    }
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
