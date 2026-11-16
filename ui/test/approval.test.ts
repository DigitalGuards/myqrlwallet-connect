import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  approvalHintText,
  approvalWalletFor,
  defineQrlApprovalHint,
  DEFAULT_APPROVAL_HINT_DELAY_MS,
  isApprovalIcon,
  QrlApprovalHint,
  QRL_APPROVAL_HINT_TAG,
} from '../src/approval.js';
import { MYQRLWALLET_CONNECT_RDNS, MYQRLWALLET_EXTENSION_RDNS } from '../src/wallets.js';

const ICON = 'data:image/png;base64,iVBORw0KGgo=';

function mount(attrs: Record<string, string> = {}): QrlApprovalHint {
  defineQrlApprovalHint();
  const el = new QrlApprovalHint();
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  document.body.appendChild(el);
  return el;
}

function text(el: QrlApprovalHint, selector: string): string {
  return el.shadowRoot?.querySelector(selector)?.textContent ?? '';
}

describe('approval hint wording', () => {
  it('names an extension wallet and where its request shows', () => {
    expect(approvalHintText({ name: 'MetaMask', kind: 'extension' })).toEqual({
      title: 'Waiting for MetaMask',
      detail:
        'Open MetaMask to approve this request. Its icon in the browser toolbar may show a small number.',
    });
  });

  it('sends the user to the paired device for a relay wallet', () => {
    expect(approvalHintText({ name: 'MyQRLWallet', kind: 'paired' })).toEqual({
      title: 'Waiting for MyQRLWallet',
      detail: 'Approve this request in MyQRLWallet on the device you paired.',
    });
  });

  it('falls back to a neutral name and caps a long one', () => {
    expect(approvalHintText({ name: '  ', kind: 'extension' }).title).toBe(
      'Waiting for your wallet'
    );
    const long = approvalHintText({ name: 'W'.repeat(80), kind: 'extension' }).title;
    expect(long).toBe(`Waiting for ${'W'.repeat(40)}…`);
  });
});

describe('approvalWalletFor', () => {
  it('reads an extension announcement as it is', () => {
    expect(
      approvalWalletFor({ uuid: 'u', name: 'MetaMask', icon: ICON, rdns: 'io.metamask' })
    ).toEqual({ name: 'MetaMask', icon: ICON, kind: 'extension' });
    expect(
      approvalWalletFor({
        uuid: 'u',
        name: 'MyQRLWallet Extension',
        icon: ICON,
        rdns: MYQRLWALLET_EXTENSION_RDNS,
      }).kind
    ).toBe('extension');
  });

  it('reads the relay announcement as a paired MyQRLWallet', () => {
    expect(
      approvalWalletFor({
        uuid: 'u',
        name: 'MyQRLWallet Connect',
        icon: ICON,
        rdns: MYQRLWALLET_CONNECT_RDNS,
      })
    ).toEqual({ name: 'MyQRLWallet', icon: ICON, kind: 'paired' });
  });

  it('drops an icon that is not an image data URI', () => {
    for (const icon of [
      'https://example.com/icon.png',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      '',
    ]) {
      expect(isApprovalIcon(icon)).toBe(false);
      expect(approvalWalletFor({ uuid: 'u', name: 'W', icon, rdns: 'x.y' }).icon).toBeNull();
    }
    expect(isApprovalIcon('data:image/svg+xml;base64,PHN2Zy8+')).toBe(true);
  });
});

describe('<qrl-approval-hint>', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  it('registers once', () => {
    defineQrlApprovalHint();
    defineQrlApprovalHint();
    expect(customElements.get(QRL_APPROVAL_HINT_TAG)).toBe(QrlApprovalHint);
  });

  it('stays hidden while no request is open', () => {
    const el = mount({ 'wallet-name': 'MetaMask' });
    vi.advanceTimersByTime(60_000);
    expect(el.hasAttribute('shown')).toBe(false);
  });

  it('shows only after the request has been open for the delay', () => {
    const el = mount({ 'wallet-name': 'MetaMask' });
    el.pending = true;
    vi.advanceTimersByTime(DEFAULT_APPROVAL_HINT_DELAY_MS - 1);
    expect(el.hasAttribute('shown')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(el.hasAttribute('shown')).toBe(true);
    expect(text(el, '.title')).toBe('Waiting for MetaMask');
  });

  it('never shows for a request that settles before the delay', () => {
    const el = mount({ 'wallet-name': 'MetaMask' });
    el.pending = true;
    vi.advanceTimersByTime(1000);
    el.pending = false;
    vi.advanceTimersByTime(60_000);
    expect(el.hasAttribute('shown')).toBe(false);
  });

  it('goes when the request settles and starts over for the next one', () => {
    const el = mount({ 'wallet-name': 'MetaMask', 'delay-ms': '500' });
    el.pending = true;
    vi.advanceTimersByTime(500);
    expect(el.hasAttribute('shown')).toBe(true);
    el.pending = false;
    expect(el.hasAttribute('shown')).toBe(false);
    el.pending = true;
    vi.advanceTimersByTime(499);
    expect(el.hasAttribute('shown')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(el.hasAttribute('shown')).toBe(true);
  });

  it('stops its timer when it leaves the page', () => {
    const el = mount({ 'wallet-name': 'MetaMask', pending: '' });
    el.remove();
    vi.advanceTimersByTime(60_000);
    expect(el.hasAttribute('shown')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('falls back to the default delay for a bad delay-ms', () => {
    const el = mount({ 'wallet-name': 'MetaMask', 'delay-ms': 'soon', pending: '' });
    vi.advanceTimersByTime(DEFAULT_APPROVAL_HINT_DELAY_MS - 1);
    expect(el.hasAttribute('shown')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(el.hasAttribute('shown')).toBe(true);
  });

  it('renders the wallet from the property, with its icon', () => {
    const el = mount();
    el.wallet = { name: 'MyQRLWallet', icon: ICON, kind: 'paired' };
    expect(text(el, '.title')).toBe('Waiting for MyQRLWallet');
    expect(text(el, '.detail')).toBe(
      'Approve this request in MyQRLWallet on the device you paired.'
    );
    expect(el.shadowRoot?.querySelector('.mark img')?.getAttribute('src')).toBe(ICON);
    expect(el.wallet).toEqual({ name: 'MyQRLWallet', icon: ICON, kind: 'paired' });
  });

  it('renders the name as text and refuses an icon that is not an image', () => {
    const el = mount({
      'wallet-name': '<img src=x onerror=alert(1)>',
      'wallet-icon': 'https://example.com/track.png',
    });
    expect(text(el, '.title')).toBe('Waiting for <img src=x onerror=alert(1)>');
    expect(el.shadowRoot?.querySelector('.title img')).toBeNull();
    expect(el.shadowRoot?.querySelector('.mark img')).toBeNull();
    expect(el.shadowRoot?.querySelector('.mark svg')).not.toBeNull();
  });

  it('announces itself politely to assistive technology', () => {
    const el = mount({ 'wallet-name': 'MetaMask' });
    const hint = el.shadowRoot?.querySelector('.hint');
    expect(hint?.getAttribute('role')).toBe('status');
    expect(hint?.getAttribute('aria-live')).toBe('polite');
  });
});
