import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineQrlPairingModal, QrlPairingModal } from '../src/element.js';

const PAIR_URI = 'qrlconnect://pair?cid=abc&blob=def';

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 20));
};

function mount(attrs: Record<string, string> = {}): QrlPairingModal {
  defineQrlPairingModal();
  const el = new QrlPairingModal();
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  document.body.appendChild(el);
  return el;
}

function shadow(el: QrlPairingModal): ShadowRoot {
  const root = el.shadowRoot;
  if (!root) throw new Error('no shadow root');
  return root;
}

function shadowText(el: QrlPairingModal, selector: string): string {
  return shadow(el).querySelector(selector)?.textContent ?? '';
}

describe('<qrl-pairing-modal>', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('renders the default wallet branding', () => {
    const el = mount({ uri: PAIR_URI });
    expect(shadowText(el, 'h2')).toBe('Pair MyQRLWallet');
    expect(shadow(el).querySelector('.sub a')?.getAttribute('href')).toBe(
      'https://myqrlwallet.com'
    );
  });

  it('honors wallet-name and wallet-url attributes', () => {
    const el = mount({
      uri: PAIR_URI,
      'wallet-name': 'TestWallet',
      'wallet-url': 'https://example.org',
    });
    expect(shadowText(el, 'h2')).toBe('Pair TestWallet');
    expect(shadow(el).querySelector('.sub a')?.getAttribute('href')).toBe('https://example.org');
    expect(shadowText(el, '.sub a')).toBe('example.org');
  });

  it('renders the URI as an SVG QR code', async () => {
    const el = mount({ uri: PAIR_URI });
    await flush();
    expect(shadow(el).querySelector('.qr svg')).not.toBeNull();
  });

  it('re-renders the QR when the uri attribute changes', async () => {
    const el = mount({ uri: PAIR_URI });
    await flush();
    const before = shadow(el).querySelector('.qr')?.innerHTML;
    el.setAttribute('uri', 'qrlconnect://pair?cid=other&blob=xyz');
    await flush();
    expect(shadow(el).querySelector('.qr svg')).not.toBeNull();
    expect(shadow(el).querySelector('.qr')?.innerHTML).not.toBe(before);
  });

  it('deep-links only qrlconnect: URIs', () => {
    const el = mount({ uri: PAIR_URI });
    const open = shadow(el).querySelector('a.btn.desktop');
    expect(open?.textContent).toContain('Open desktop app');
    expect(open?.getAttribute('href')).toBe(PAIR_URI);
    el.setAttribute('uri', 'javascript:alert(1)');
    expect(open?.getAttribute('href')).toBeNull();
  });

  describe('web wallet handoff link', () => {
    const WEIRD_URI = 'qrlconnect://pair?cid=a%25b&blob=c+d&r=https://relay.example/?x=1&y=2';
    const webLink = (el: QrlPairingModal) => shadow(el).querySelector('a.btn.web');

    it('builds the default fragment link with the URI exactly once-encoded', () => {
      const el = mount({ uri: WEIRD_URI });
      const link = webLink(el);
      expect(link?.getAttribute('href')).toBe(
        `https://qrlwallet.com/dapp-sessions#qrlconnect=${encodeURIComponent(WEIRD_URI)}`
      );
      expect(link?.getAttribute('target')).toBe('_blank');
      expect(link?.getAttribute('rel')).toBe('noreferrer');
    });

    it('honors a custom web-wallet-url and strips trailing slashes', () => {
      const el = mount({ uri: PAIR_URI, 'web-wallet-url': 'https://dev.qrlwallet.com/' });
      expect(webLink(el)?.getAttribute('href')).toBe(
        `https://dev.qrlwallet.com/dapp-sessions#qrlconnect=${encodeURIComponent(PAIR_URI)}`
      );
    });

    it('is hidden and href-less when opted out with an empty attribute', () => {
      const el = mount({ uri: PAIR_URI, 'web-wallet-url': '' });
      const link = webLink(el);
      expect(link?.getAttribute('href')).toBeNull();
      expect((link as HTMLElement).hidden).toBe(true);
    });

    it('is hidden for a non-pairing uri', () => {
      const el = mount({ uri: 'javascript:alert(1)' });
      const link = webLink(el);
      expect(link?.getAttribute('href')).toBeNull();
      expect((link as HTMLElement).hidden).toBe(true);
    });

    it('refuses a non-web base URL', () => {
      const el = mount({ uri: PAIR_URI, 'web-wallet-url': 'javascript:alert(1)' });
      const link = webLink(el);
      expect(link?.getAttribute('href')).toBeNull();
      expect((link as HTMLElement).hidden).toBe(true);
    });

    it('rotates the link when the uri attribute changes', () => {
      const el = mount({ uri: PAIR_URI });
      const next = 'qrlconnect://pair?cid=other&blob=xyz';
      el.setAttribute('uri', next);
      expect(webLink(el)?.getAttribute('href')).toBe(
        `https://qrlwallet.com/dapp-sessions#qrlconnect=${encodeURIComponent(next)}`
      );
    });
  });

  it('shows the status line only when set', () => {
    const el = mount({ uri: PAIR_URI });
    expect(shadowText(el, '.status')).toBe('');
    el.setAttribute('status', 'waiting');
    expect(shadowText(el, '.status')).toBe('status: waiting');
  });

  it('copies the URI to the clipboard with feedback', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const el = mount({ uri: PAIR_URI });
    const buttons = shadow(el).querySelectorAll('button.btn');
    const copy = buttons[0] as HTMLButtonElement;
    copy.click();
    await flush();
    expect(writeText).toHaveBeenCalledWith(PAIR_URI);
    expect(copy.textContent).toContain('Copied!');
  });

  it('dispatches qrl-cancel from the Cancel action and Escape', () => {
    const el = mount({ uri: PAIR_URI });
    const cancelled = vi.fn();
    el.addEventListener('qrl-cancel', cancelled);
    const links = shadow(el).querySelectorAll('button.link');
    (links[1] as HTMLButtonElement).click();
    expect(cancelled).toHaveBeenCalledTimes(1);
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(cancelled).toHaveBeenCalledTimes(2);
  });

  it('dispatches qrl-cancel when removed from the DOM', () => {
    const el = mount({ uri: PAIR_URI });
    const cancelled = vi.fn();
    el.addEventListener('qrl-cancel', cancelled);
    el.remove();
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it('dispatches qrl-new-connection from the New connection action', () => {
    const el = mount({ uri: PAIR_URI });
    const rotated = vi.fn();
    el.addEventListener('qrl-new-connection', rotated);
    const links = shadow(el).querySelectorAll('button.link');
    (links[0] as HTMLButtonElement).click();
    expect(rotated).toHaveBeenCalledTimes(1);
  });

  it('exposes a dialog with aria wiring and moves focus into it', async () => {
    const el = mount({ uri: PAIR_URI });
    const card = shadow(el).querySelector('.card');
    expect(card?.getAttribute('role')).toBe('dialog');
    expect(card?.getAttribute('aria-modal')).toBe('true');
    await flush();
    expect(shadow(el).activeElement).toBe(card);
  });
});
