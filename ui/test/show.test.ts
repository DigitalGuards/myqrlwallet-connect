import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QRLConnectProvider } from '@qrlwallet/connect';
import { showPairingModal, type PairingProvider } from '../src/show.js';
import { QRL_PAIRING_MODAL_TAG } from '../src/element.js';

// Compile-time contract: the real provider must satisfy the duck-typed
// subset this package consumes. Enforced by `npm run typecheck`.
const _providerSatisfiesInterface = (provider: QRLConnectProvider): PairingProvider => provider;

type Listener = (...args: unknown[]) => void;

class FakeProvider implements PairingProvider {
  uri = 'qrlconnect://pair?cid=first';
  mobile = false;
  private readonly listeners = new Map<string, Set<Listener>>();

  getConnectionURI(): Promise<string> {
    return Promise.resolve(this.uri);
  }

  newConnection(): Promise<string> {
    this.uri = 'qrlconnect://pair?cid=rotated';
    return Promise.resolve(this.uri);
  }

  isMobile(): boolean {
    return this.mobile;
  }

  on(event: string, listener: Listener): this {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(event, set);
    return this;
  }

  off(event: string, listener: Listener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 20));
};

const findModal = (): Element | null => document.querySelector(QRL_PAIRING_MODAL_TAG);

describe('showPairingModal', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('mounts the modal with the provider URI and resolves on connect', async () => {
    const provider = new FakeProvider();
    const result = showPairingModal(provider);
    await flush();
    const modal = findModal();
    expect(modal?.getAttribute('uri')).toBe('qrlconnect://pair?cid=first');
    provider.emit('connect', { chainId: '0x539' });
    await expect(result).resolves.toBe('connected');
    expect(findModal()).toBeNull();
    expect(provider.listenerCount('connect')).toBe(0);
    expect(provider.listenerCount('statusChanged')).toBe(0);
  });

  it('reflects statusChanged events on the modal', async () => {
    const provider = new FakeProvider();
    const result = showPairingModal(provider);
    await flush();
    provider.emit('statusChanged', 'waiting');
    expect(findModal()?.getAttribute('status')).toBe('waiting');
    provider.emit('connect', { chainId: '0x539' });
    await result;
  });

  it('resolves cancelled when the user dismisses the dialog', async () => {
    const provider = new FakeProvider();
    const result = showPairingModal(provider);
    await flush();
    findModal()?.dispatchEvent(new CustomEvent('qrl-cancel'));
    await expect(result).resolves.toBe('cancelled');
    expect(findModal()).toBeNull();
  });

  it('rotates the URI on qrl-new-connection', async () => {
    const provider = new FakeProvider();
    const result = showPairingModal(provider);
    await flush();
    findModal()?.dispatchEvent(new CustomEvent('qrl-new-connection'));
    await flush();
    expect(findModal()?.getAttribute('uri')).toBe('qrlconnect://pair?cid=rotated');
    provider.emit('connect', { chainId: '0x539' });
    await result;
  });

  it('starts from a fresh connection when options.fresh is set', async () => {
    const provider = new FakeProvider();
    const spy = vi.spyOn(provider, 'newConnection');
    const result = showPairingModal(provider, { fresh: true });
    await flush();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(findModal()?.getAttribute('uri')).toBe('qrlconnect://pair?cid=rotated');
    provider.emit('connect', { chainId: '0x539' });
    await result;
  });

  it('resolves cancelled when the modal is removed from the DOM externally', async () => {
    const provider = new FakeProvider();
    const result = showPairingModal(provider);
    await flush();
    const modal = findModal();
    if (!(modal instanceof HTMLElement)) throw new Error('modal not mounted');
    modal.remove();
    await expect(result).resolves.toBe('cancelled');
    expect(provider.listenerCount('connect')).toBe(0);
    expect(provider.listenerCount('statusChanged')).toBe(0);
  });

  it('refuses the mobile redirect for a non-qrlconnect URI', async () => {
    const provider = new FakeProvider();
    provider.uri = 'javascript:alert(1)';
    provider.mobile = true;
    await expect(showPairingModal(provider)).rejects.toThrow('qrlconnect: scheme');
    expect(findModal()).toBeNull();
  });

  it('shows the modal on mobile when mobileRedirect is disabled', async () => {
    const provider = new FakeProvider();
    provider.mobile = true;
    const result = showPairingModal(provider, { mobileRedirect: false });
    await flush();
    expect(findModal()).not.toBeNull();
    provider.emit('connect', { chainId: '0x539' });
    await expect(result).resolves.toBe('connected');
  });

  it('passes wallet branding options through to the element', async () => {
    const provider = new FakeProvider();
    const result = showPairingModal(provider, {
      walletName: 'TestWallet',
      walletUrl: 'https://example.org',
    });
    await flush();
    expect(findModal()?.getAttribute('wallet-name')).toBe('TestWallet');
    expect(findModal()?.getAttribute('wallet-url')).toBe('https://example.org');
    provider.emit('connect', { chainId: '0x539' });
    await result;
  });

  it('passes webWalletUrl through, including the empty-string opt-out', async () => {
    const provider = new FakeProvider();
    const result = showPairingModal(provider, { webWalletUrl: '' });
    await flush();
    expect(findModal()?.getAttribute('web-wallet-url')).toBe('');
    provider.emit('connect', { chainId: '0x539' });
    await result;
  });
});
