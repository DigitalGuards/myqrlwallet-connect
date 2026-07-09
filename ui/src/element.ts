// <qrl-pairing-modal>: the MyQRLWallet pairing dialog as a framework-free
// custom element. Purely presentational: it renders a `uri` attribute and
// emits `qrl-cancel` / `qrl-new-connection` events; all protocol work stays
// in @qrlwallet/connect (usually wired up via showPairingModal()).
//
// UX invariants carried over from the hand-copied dApp modals:
// QR render of the URI, "Open web wallet" fragment-link handoff,
// qrlconnect:// "Open desktop app" deep link, copy-code fallback, live
// status line, New connection and Cancel actions.
//
// A web page cannot detect whether the qrlconnect:// handler (desktop app)
// is installed, and a scheme click without a handler silently no-ops, so
// the modal offers every path explicitly and the user picks. The wallet
// side tells them apart by ingress channel.

import { qrSvg } from './qr.js';
import { ICON_COPY, ICON_EXTERNAL_LINK, ICON_REFRESH, modalStyles } from './styles.js';

export const QRL_PAIRING_MODAL_TAG = 'qrl-pairing-modal';

const COPY_FEEDBACK_MS = 1500;

/** Only ever deep-link or redirect to the wallet's own scheme. */
export const isPairingUri = (uri: string): boolean => uri.startsWith('qrlconnect:');
const isWebUrl = (url: string): boolean => url.startsWith('https://') || url.startsWith('http://');

function makeIcon(svg: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'icon';
  span.innerHTML = svg;
  return span;
}

export class QrlPairingModal extends HTMLElement {
  static get observedAttributes(): string[] {
    return ['uri', 'status', 'wallet-name', 'wallet-url', 'web-wallet-url'];
  }

  private readonly shadow: ShadowRoot;
  private readonly card: HTMLDivElement;
  private readonly titleEl: HTMLHeadingElement;
  private readonly walletLink: HTMLAnchorElement;
  private readonly qrBox: HTMLDivElement;
  private readonly statusEl: HTMLParagraphElement;
  private readonly webLink: HTMLAnchorElement;
  private readonly openLink: HTMLAnchorElement;
  private readonly copyLabel: HTMLSpanElement;

  private qrToken = 0;
  private lastQrUri: string | null = null;
  private copyTimer: ReturnType<typeof setTimeout> | null = null;
  private restoreFocus: HTMLElement | null = null;

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = modalStyles;

    const backdrop = document.createElement('div');
    backdrop.className = 'backdrop';
    backdrop.addEventListener('mousedown', (event) => {
      if (event.target === backdrop) this.fire('qrl-cancel');
    });

    this.card = document.createElement('div');
    this.card.className = 'card';
    this.card.setAttribute('role', 'dialog');
    this.card.setAttribute('aria-modal', 'true');
    this.card.setAttribute('aria-labelledby', 'qrl-pairing-title');
    this.card.tabIndex = -1;

    this.titleEl = document.createElement('h2');
    this.titleEl.id = 'qrl-pairing-title';

    const sub = document.createElement('p');
    sub.className = 'sub';
    sub.append('Scan with the mobile app, or open the web wallet. Get the apps at ');
    this.walletLink = document.createElement('a');
    this.walletLink.target = '_blank';
    this.walletLink.rel = 'noreferrer';
    sub.append(this.walletLink);

    this.qrBox = document.createElement('div');
    this.qrBox.className = 'qr';
    this.qrBox.setAttribute('aria-label', 'qrlconnect pairing QR code');

    this.statusEl = document.createElement('p');
    this.statusEl.className = 'status';
    this.statusEl.setAttribute('aria-live', 'polite');

    const actions = document.createElement('div');
    actions.className = 'actions';

    // Full-width on top: the only zero-install path that always works.
    this.webLink = document.createElement('a');
    this.webLink.className = 'btn wide web';
    this.webLink.target = '_blank';
    this.webLink.rel = 'noreferrer';
    this.webLink.title = 'Opens the web wallet in a new tab to approve this connection';
    this.webLink.append(makeIcon(ICON_EXTERNAL_LINK), 'Open web wallet');

    this.openLink = document.createElement('a');
    this.openLink.className = 'btn desktop';
    this.openLink.title = 'Opens the MyQRLWallet desktop app if installed';
    this.openLink.append(makeIcon(ICON_EXTERNAL_LINK), 'Open desktop app');

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn';
    this.copyLabel = document.createElement('span');
    this.copyLabel.textContent = 'Copy code';
    copyBtn.append(makeIcon(ICON_COPY), this.copyLabel);
    copyBtn.addEventListener('click', () => {
      this.copyUri();
    });

    actions.append(this.webLink, this.openLink, copyBtn);

    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent =
      'No protocol handler? Copy the code and paste it under dApp Sessions in the desktop or web wallet.';

    const links = document.createElement('div');
    links.className = 'links';

    const newBtn = document.createElement('button');
    newBtn.type = 'button';
    newBtn.className = 'link';
    newBtn.append(makeIcon(ICON_REFRESH), 'New connection');
    newBtn.addEventListener('click', () => {
      this.fire('qrl-new-connection');
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'link';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => {
      this.fire('qrl-cancel');
    });

    links.append(newBtn, cancelBtn);
    this.card.append(this.titleEl, sub, this.qrBox, this.statusEl, actions, hint, links);
    backdrop.append(this.card);
    this.shadow.append(style, backdrop);

    this.addEventListener('keydown', (event) => {
      this.handleKeydown(event);
    });

    this.syncAll();
  }

  get uri(): string | null {
    return this.getAttribute('uri');
  }

  set uri(value: string | null) {
    if (value === null) this.removeAttribute('uri');
    else this.setAttribute('uri', value);
  }

  attributeChangedCallback(name: string, _oldValue: string | null, _newValue: string | null): void {
    switch (name) {
      case 'uri':
        this.syncUri();
        this.syncWebWalletLink();
        break;
      case 'status':
        this.syncStatus();
        break;
      case 'wallet-name':
      case 'wallet-url':
        this.syncWallet();
        break;
      case 'web-wallet-url':
        this.syncWebWalletLink();
        break;
      default:
        break;
    }
  }

  connectedCallback(): void {
    const active = document.activeElement;
    this.restoreFocus = active instanceof HTMLElement ? active : null;
    // Move focus into the dialog once it is in the tree.
    queueMicrotask(() => {
      if (this.isConnected) this.card.focus();
    });
  }

  disconnectedCallback(): void {
    if (this.copyTimer !== null) clearTimeout(this.copyTimer);
    this.copyTimer = null;
    if (this.restoreFocus?.isConnected) this.restoreFocus.focus();
    this.restoreFocus = null;
    // Removal is dismissal: if the element leaves the DOM for any reason
    // (route change, parent unmount), tell wiring like showPairingModal()
    // so pending promises settle and provider listeners are released.
    // Listeners attached directly to the element still receive this.
    this.fire('qrl-cancel');
  }

  private fire(name: 'qrl-cancel' | 'qrl-new-connection'): void {
    this.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true }));
  }

  private syncAll(): void {
    this.syncWallet();
    this.syncStatus();
    this.syncUri();
    this.syncWebWalletLink();
  }

  private syncWallet(): void {
    const name = this.getAttribute('wallet-name') ?? 'MyQRLWallet';
    const url = this.getAttribute('wallet-url') ?? 'https://myqrlwallet.com';
    this.titleEl.textContent = `Pair ${name}`;
    this.walletLink.textContent = url.replace(/^https?:\/\//, '');
    if (isWebUrl(url)) this.walletLink.setAttribute('href', url);
    else this.walletLink.removeAttribute('href');
  }

  private syncStatus(): void {
    const status = this.getAttribute('status');
    this.statusEl.textContent = status !== null && status !== '' ? `status: ${status}` : '';
  }

  private syncUri(): void {
    const uri = this.getAttribute('uri');
    if (uri !== null && isPairingUri(uri)) this.openLink.setAttribute('href', uri);
    else this.openLink.removeAttribute('href');
    if (uri === this.lastQrUri) return;
    this.lastQrUri = uri;
    this.renderQr(uri);
  }

  /**
   * The web-wallet handoff: an https link carrying the pairing URI in the
   * URL fragment (never sent to servers; the wallet scrubs and stages it
   * behind its consent modal). Attribute absent = default web wallet;
   * attribute set but empty = feature disabled. Hidden links carry no href,
   * which also keeps them out of the focus trap.
   */
  private syncWebWalletLink(): void {
    const attr = this.getAttribute('web-wallet-url');
    const base = attr ?? 'https://qrlwallet.com';
    const uri = this.getAttribute('uri');
    const enabled = base !== '' && isWebUrl(base) && uri !== null && isPairingUri(uri);
    if (!enabled) {
      this.webLink.removeAttribute('href');
      this.webLink.hidden = true;
      return;
    }
    this.webLink.hidden = false;
    this.webLink.setAttribute(
      'href',
      `${base.replace(/\/+$/, '')}/dapp-sessions#qrlconnect=${encodeURIComponent(uri)}`
    );
  }

  private renderQr(uri: string | null): void {
    const token = ++this.qrToken;
    if (uri === null || uri === '') {
      this.qrBox.textContent = '';
      return;
    }
    this.qrBox.textContent = 'Generating…';
    void qrSvg(uri)
      .then((svg) => {
        if (token !== this.qrToken) return;
        this.qrBox.innerHTML = svg;
      })
      .catch(() => {
        if (token === this.qrToken) this.qrBox.textContent = 'Could not render the QR code';
      });
  }

  private copyUri(): void {
    const uri = this.getAttribute('uri') ?? '';
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (uri === '' || clipboard === undefined) {
      this.showCopyFeedback('Copy failed');
      return;
    }
    void clipboard
      .writeText(uri)
      .then(() => {
        this.showCopyFeedback('Copied!');
      })
      .catch(() => {
        this.showCopyFeedback('Copy failed');
      });
  }

  private showCopyFeedback(text: string): void {
    this.copyLabel.textContent = text;
    if (this.copyTimer !== null) clearTimeout(this.copyTimer);
    this.copyTimer = setTimeout(() => {
      this.copyLabel.textContent = 'Copy code';
      this.copyTimer = null;
    }, COPY_FEEDBACK_MS);
  }

  private focusables(): HTMLElement[] {
    const nodes = this.shadow.querySelectorAll('a[href], button');
    const result: HTMLElement[] = [];
    nodes.forEach((node) => {
      if (node instanceof HTMLElement) result.push(node);
    });
    return result;
  }

  private handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      this.fire('qrl-cancel');
      return;
    }
    if (event.key !== 'Tab') return;
    // Focus trap: cycle within the dialog.
    const items = this.focusables();
    const first = items[0];
    const last = items[items.length - 1];
    if (first === undefined || last === undefined) return;
    const active = this.shadow.activeElement;
    if (event.shiftKey && (active === first || active === this.card)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }
}

export function defineQrlPairingModal(tagName: string = QRL_PAIRING_MODAL_TAG): void {
  if (typeof customElements === 'undefined') return;
  if (customElements.get(tagName) === undefined) customElements.define(tagName, QrlPairingModal);
}
