// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { approvalHintText, approvalWalletFor } from '../src/wallets.js';

describe('the approval helpers without a DOM', () => {
  it('load from the wallets entry and work', () => {
    expect(typeof HTMLElement).toBe('undefined');
    const wallet = approvalWalletFor({
      uuid: 'u',
      name: 'MetaMask',
      icon: '',
      rdns: 'io.metamask',
    });
    expect(wallet).toEqual({ name: 'MetaMask', icon: null, kind: 'extension' });
    expect(approvalHintText(wallet).title).toBe('Waiting for MetaMask');
  });
});
