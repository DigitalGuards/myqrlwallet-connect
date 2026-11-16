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
import {
  MYQRLWALLET_CONNECT_RDNS,
  MYQRLWALLET_EXTENSION_RDNS,
  type Eip6963ProviderInfo,
} from '../src/wallets.js';

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

  it('removes invisible and direction-override characters and never splits a character', () => {
    expect(approvalHintText({ name: 'Meta\u202EksaM\u200B', kind: 'extension' }).title).toBe(
      'Waiting for MetaksaM'
    );
    const emoji = approvalHintText({ name: `${'W'.repeat(39)}\u{1F98A}tail`, kind: 'extension' });
    expect(emoji.title).toBe(`Waiting for ${'W'.repeat(39)}\u{1F98A}…`);
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
    expect(isApprovalIcon(`data:image/png;base64,${'A'.repeat(300_000)}`)).toBe(false);
  });

  it('survives an announcement whose name is not a string', () => {
    // What an untyped page hands over: the shape is claimed, never checked.
    const claimed = (value: unknown): value is Eip6963ProviderInfo => value !== null;
    const raw: unknown = { uuid: 'u', name: 123, icon: ICON, rdns: 'x.y' };
    if (!claimed(raw)) throw new Error('unreachable');
    const wallet = approvalWalletFor(raw);
    expect(wallet.name).toBe('');
    expect(approvalHintText(wallet).title).toBe('Waiting for your wallet');
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

  it('keeps the hint and the time already waited across a move in the page', () => {
    const el = mount({ 'wallet-name': 'MetaMask', pending: '' });
    vi.advanceTimersByTime(2000);
    const other = document.createElement('div');
    document.body.append(other);
    other.append(el);
    vi.advanceTimersByTime(499);
    expect(el.hasAttribute('shown')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(el.hasAttribute('shown')).toBe(true);
    document.body.append(el);
    expect(el.hasAttribute('shown')).toBe(true);
    // A request that settles while the element is off the page clears it.
    el.remove();
    el.pending = false;
    document.body.append(el);
    expect(el.hasAttribute('shown')).toBe(false);
  });

  it('treats pending set again as the same open request', () => {
    const el = mount({ 'wallet-name': 'MetaMask', pending: '' });
    for (let elapsed = 0; elapsed < 2400; elapsed += 400) {
      vi.advanceTimersByTime(400);
      el.setAttribute('pending', '');
    }
    vi.advanceTimersByTime(100);
    expect(el.hasAttribute('shown')).toBe(true);
  });

  it('counts the time already waited when the delay changes', () => {
    const el = mount({ 'wallet-name': 'MetaMask', pending: '' });
    vi.advanceTimersByTime(2000);
    el.setAttribute('delay-ms', '3000');
    vi.advanceTimersByTime(999);
    expect(el.hasAttribute('shown')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(el.hasAttribute('shown')).toBe(true);
  });

  it('fills the live region only when the hint appears', () => {
    const el = mount({ 'wallet-name': 'MetaMask', 'delay-ms': '100' });
    expect(text(el, '.title')).toBe('');
    el.pending = true;
    expect(text(el, '.title')).toBe('');
    vi.advanceTimersByTime(100);
    expect(text(el, '.title')).toBe('Waiting for MetaMask');
    el.pending = false;
    expect(text(el, '.title')).toBe('');
  });

  it('takes over values set before the element was defined', () => {
    const el = mount({ 'delay-ms': '0' });
    el.remove();
    // What a framework leaves behind when it wrote the properties early.
    Object.defineProperty(el, 'pending', { value: true, writable: true, configurable: true });
    Object.defineProperty(el, 'wallet', {
      value: { name: 'MetaMask', icon: null, kind: 'extension' },
      writable: true,
      configurable: true,
    });
    document.body.append(el);
    vi.advanceTimersByTime(0);
    expect(el.getAttribute('wallet-name')).toBe('MetaMask');
    expect(el.hasAttribute('shown')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(el, 'pending')).toBe(false);
  });

  it('falls back to the default delay for a bad delay-ms', () => {
    const el = mount({ 'wallet-name': 'MetaMask', 'delay-ms': 'soon', pending: '' });
    vi.advanceTimersByTime(DEFAULT_APPROVAL_HINT_DELAY_MS - 1);
    expect(el.hasAttribute('shown')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(el.hasAttribute('shown')).toBe(true);
  });

  it('renders the wallet from the property, with its icon', () => {
    const el = mount({ 'delay-ms': '0', pending: '' });
    vi.advanceTimersByTime(0);
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
      'delay-ms': '0',
      pending: '',
    });
    vi.advanceTimersByTime(0);
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
