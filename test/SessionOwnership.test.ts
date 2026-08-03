import { describe, expect, it, vi } from 'vitest';
import { SessionOwnership } from '../src/SessionOwnership.js';

function deferredLockManager(): {
  manager: LockManager;
  dispatchNext: () => Promise<void>;
} {
  const callbacks: ((lock: Lock | null) => void | PromiseLike<void>)[] = [];
  const completions: {
    resolve: () => void;
    reject: (error: unknown) => void;
  }[] = [];

  const manager = {
    request: vi.fn(
      (
        _name: string,
        _options: LockOptions,
        callback: (lock: Lock | null) => void | PromiseLike<void>
      ): Promise<void> => {
        callbacks.push(callback);
        return new Promise<void>((resolve, reject) => {
          completions.push({ resolve, reject });
        });
      }
    ),
  } as unknown as LockManager;

  return {
    manager,
    dispatchNext: async () => {
      const callback = callbacks.shift();
      const completion = completions.shift();
      if (!callback || !completion) throw new Error('No deferred lock request');
      try {
        await callback({ name: 'test:aead-owner', mode: 'exclusive' });
        completion.resolve();
      } catch (error) {
        completion.reject(error);
      }
    },
  };
}

describe('SessionOwnership', () => {
  it('fails closed when the lock manager throws synchronously', async () => {
    const manager = {
      request: vi.fn(() => {
        throw new Error('locks unavailable');
      }),
    } as unknown as LockManager;
    const ownership = new SessionOwnership('test', manager);

    await expect(ownership.acquire()).resolves.toBe(false);
    expect(ownership.isOwned()).toBe(false);
    await expect(ownership.release()).resolves.toBeUndefined();
  });

  it('cancels and drains an acquire whose lock callback arrives after release', async () => {
    const locks = deferredLockManager();
    const ownership = new SessionOwnership('test', locks.manager);

    const acquire = ownership.acquire();
    const release = ownership.release();
    const dispatch = locks.dispatchNext();

    await expect(acquire).resolves.toBe(false);
    await expect(release).resolves.toBeUndefined();
    await dispatch;
    expect(ownership.isOwned()).toBe(false);

    const reacquire = ownership.acquire();
    const secondDispatch = locks.dispatchNext();
    await expect(reacquire).resolves.toBe(true);
    expect(ownership.isOwned()).toBe(true);

    const finalRelease = ownership.release();
    const queuedReacquire = ownership.acquire();
    const cancelQueuedReacquire = ownership.release();
    await secondDispatch;
    await finalRelease;
    await cancelQueuedReacquire;
    await expect(queuedReacquire).resolves.toBe(false);
    expect(ownership.isOwned()).toBe(false);
  });
});
