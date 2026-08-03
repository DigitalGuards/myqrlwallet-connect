/**
 * Exclusive browser-tab ownership for one persisted AEAD session.
 *
 * A persisted key and its counters form one state machine. Hydrating the same
 * record in two tabs lets both tabs reserve the same AES-GCM sequence number.
 * Web Locks gives us the required origin-wide atomic exclusion. Browsers that
 * do not expose Web Locks use in-memory sessions only.
 */

import { warn } from './utils/logger.js';

export function getBrowserStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function getBrowserLockManager(): LockManager | null {
  try {
    if (typeof navigator === 'undefined') return null;
    return navigator.locks ?? null;
  } catch {
    return null;
  }
}

export class SessionOwnership {
  private readonly lockName: string;
  private readonly lockManager: LockManager;
  private owned = false;
  private acquireInFlight: Promise<boolean> | null = null;
  private releaseLock: (() => void) | null = null;
  private lockRequest: Promise<void> | null = null;
  private releaseInFlight: Promise<void> | null = null;
  // Monotonic attempt identity. release() advances it before waiting for the
  // Web Locks request, so a callback dispatched after teardown can observe
  // cancellation and decline a late grant.
  private ownershipGeneration = 0;

  constructor(storageKey: string, lockManager: LockManager) {
    this.lockName = `${storageKey}:aead-owner`;
    this.lockManager = lockManager;
  }

  isOwned(): boolean {
    return this.owned;
  }

  async acquire(): Promise<boolean> {
    // Capture intent before awaiting a release. A later release() represents
    // teardown and must cancel this waiter instead of letting it acquire once
    // that teardown finishes.
    const generation = this.ownershipGeneration;
    if (this.releaseInFlight) await this.releaseInFlight;
    if (generation !== this.ownershipGeneration) return false;
    if (this.owned) return true;
    if (this.acquireInFlight) return this.acquireInFlight;
    const task = this.startAcquire(generation);
    this.acquireInFlight = task;
    try {
      return await task;
    } finally {
      if (this.acquireInFlight === task) this.acquireInFlight = null;
    }
  }

  private startAcquire(generation: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let grantSettled = false;
      const settleGrant = (granted: boolean): void => {
        if (grantSettled) return;
        grantSettled = true;
        resolve(granted);
      };

      let request: Promise<unknown>;
      try {
        request = this.lockManager.request(
          this.lockName,
          { mode: 'exclusive', ifAvailable: true },
          async (lock): Promise<void> => {
            if (!lock || generation !== this.ownershipGeneration) {
              settleGrant(false);
              return;
            }
            this.owned = true;
            settleGrant(true);
            await new Promise<void>((release) => {
              this.releaseLock = release;
            });
            this.releaseLock = null;
            this.owned = false;
          }
        );
      } catch (err) {
        warn('SessionOwnership', 'Web Lock request failed:', err);
        settleGrant(false);
        return;
      }

      this.lockRequest = request
        .then(() => undefined)
        .catch((err: unknown) => {
          warn('SessionOwnership', 'Web Lock request failed:', err);
          settleGrant(false);
        });
    });
  }

  release(): Promise<void> {
    // Advance even when another release is already draining. This also
    // cancels acquire() calls that started waiting during that earlier drain.
    this.ownershipGeneration++;
    if (this.releaseInFlight) return this.releaseInFlight;

    // Invalidate an acquire whose Web Locks callback has not run yet. Awaiting
    // lockRequest below guarantees that callback cannot become an owner after
    // this release has completed.
    const task = this.finishRelease();
    const tracked = task.finally(() => {
      if (this.releaseInFlight === tracked) this.releaseInFlight = null;
    });
    this.releaseInFlight = tracked;
    return tracked;
  }

  private async finishRelease(): Promise<void> {
    const release = this.releaseLock;
    this.releaseLock = null;
    if (release) release();

    // This is also present while an ifAvailable callback is still waiting to
    // be dispatched. It will see the generation mismatch and return without
    // taking ownership.
    const request = this.lockRequest;
    if (request) await request;

    this.owned = false;
    this.acquireInFlight = null;
    if (this.lockRequest === request) this.lockRequest = null;
  }
}
