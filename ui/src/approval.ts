// <qrl-approval-hint>: tells the user which wallet is waiting for them.
//
// A wallet does not always come to the front when a dApp sends a request:
// an extension can sit behind a small number on its toolbar icon, and a
// paired phone or desktop wallet is another device altogether. A page cannot
// open or raise a wallet, and it should not try. What it can do is say, right
// where the user is looking, which wallet to open.
//
// Purely presentational and passive. The dApp sets `pending` while one of its
// wallet requests is open and removes it when the request settles (a hash, a
// signature, a rejection or an error). The hint appears after a short delay,
// so a prompt that opens by itself never flashes it. It makes no focus,
// window or wallet calls.
//
// The wallet's name and icon come from its own EIP-6963 announcement. The
// name is rendered as text and the icon only when it is an image data URI.

import type { ApprovalRequests } from './approvalRequests.js';
import { approvalHintText, isApprovalIcon, type ApprovalWallet } from './approvalWallet.js';

export {
  approvalHintText,
  approvalWalletFor,
  isApprovalIcon,
  type ApprovalHintText,
  type ApprovalWallet,
  type ApprovalWalletKind,
} from './approvalWallet.js';

export const QRL_APPROVAL_HINT_TAG = 'qrl-approval-hint';

/** Default time a request may stay open before the hint appears: two and a half seconds. */
export const DEFAULT_APPROVAL_HINT_DELAY_MS = 2500;

const ICON_WALLET =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M19 7V5a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v3"/>' +
  '<path d="M3 6v12a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-3"/>' +
  '<path d="M21 12h-4a2 2 0 0 0 0 4h4z"/>' +
  '</svg>';

// Theme properties are the pairing modal's, so a dApp themes both at once.
const hintStyles = `
:host {
  --_qrl-accent: var(--qrl-modal-accent, hsl(199 78% 55%));
  --_qrl-fg: var(--qrl-modal-fg, hsl(210 30% 96%));
  --_qrl-muted: var(--qrl-modal-muted, hsl(215 15% 66%));
  --_qrl-radius: var(--qrl-modal-radius, 12px);
  --_qrl-font: var(--qrl-modal-font, 'Instrument Sans Variable', ui-sans-serif, system-ui, sans-serif);
  display: block;
  font-family: var(--_qrl-font);
  line-height: 1.45;
}
:host(:not([shown])) {
  display: none;
}
*, *::before, *::after {
  box-sizing: border-box;
}
.hint {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  color: var(--_qrl-fg);
  background: color-mix(in srgb, var(--_qrl-accent) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--_qrl-accent) 40%, transparent);
  border-radius: var(--_qrl-radius);
  text-align: left;
}
.mark {
  flex: none;
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  color: var(--_qrl-accent);
  border-radius: 10px;
  animation: qrl-approval-ring 1.8s ease-out infinite;
}
.mark img,
.mark svg {
  width: 28px;
  height: 28px;
  border-radius: 6px;
}
.text {
  min-width: 0;
}
.title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.detail {
  margin: 2px 0 0;
  font-size: 13px;
  color: var(--_qrl-muted);
  overflow-wrap: anywhere;
}
@keyframes qrl-approval-ring {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--_qrl-accent) 55%, transparent); }
  70% { box-shadow: 0 0 0 9px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}
@media (prefers-reduced-motion: reduce) {
  .mark {
    animation: none;
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--_qrl-accent) 45%, transparent);
  }
}
`;

function parseDelay(value: string | null): number {
  if (value === null) return DEFAULT_APPROVAL_HINT_DELAY_MS;
  const delay = Number(value);
  return Number.isFinite(delay) && delay >= 0 ? delay : DEFAULT_APPROVAL_HINT_DELAY_MS;
}

/**
 * Attributes:
 * - `pending`: present while a wallet request is open. The hint shows once it
 *   has been present for `delay-ms` and goes when it is removed.
 * - `wallet-name`, `wallet-icon`, `kind` (`extension` or `paired`): the wallet.
 *   The `wallet` property sets all three.
 * - `delay-ms`: milliseconds before the hint shows. Default 2500.
 *
 * The element sets `shown` on itself while the hint is visible.
 */
export class QrlApprovalHint extends HTMLElement {
  static get observedAttributes(): string[] {
    return ['pending', 'wallet-name', 'wallet-icon', 'kind', 'delay-ms'];
  }

  private readonly markEl: HTMLSpanElement;
  private readonly titleEl: HTMLParagraphElement;
  private readonly detailEl: HTMLParagraphElement;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** When the open request was first seen (`Date.now()`), or null without one. */
  private pendingSince: number | null = null;

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = hintStyles;

    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.setAttribute('role', 'status');
    hint.setAttribute('aria-live', 'polite');

    this.markEl = document.createElement('span');
    this.markEl.className = 'mark';

    const text = document.createElement('div');
    text.className = 'text';
    this.titleEl = document.createElement('p');
    this.titleEl.className = 'title';
    this.detailEl = document.createElement('p');
    this.detailEl.className = 'detail';
    text.append(this.titleEl, this.detailEl);

    hint.append(this.markEl, text);
    shadow.append(style, hint);
  }

  /** The wallet the request waits for. Setting it writes the three wallet attributes. */
  get wallet(): ApprovalWallet {
    const icon = this.getAttribute('wallet-icon');
    return {
      name: this.getAttribute('wallet-name') ?? '',
      icon: isApprovalIcon(icon) ? icon : null,
      kind: this.getAttribute('kind') === 'paired' ? 'paired' : 'extension',
    };
  }

  set wallet(wallet: ApprovalWallet) {
    this.setAttribute('wallet-name', wallet.name);
    this.setAttribute('kind', wallet.kind);
    if (isApprovalIcon(wallet.icon)) this.setAttribute('wallet-icon', wallet.icon);
    else this.removeAttribute('wallet-icon');
  }

  /** A wallet request is open. */
  get pending(): boolean {
    return this.hasAttribute('pending');
  }

  set pending(pending: boolean) {
    this.toggleAttribute('pending', pending);
  }

  connectedCallback(): void {
    // Values a framework set before the element was defined sit on the
    // instance and hide the accessors. Hand them to the accessors.
    this.upgradeProperty('wallet');
    this.upgradeProperty('pending');
    this.schedule();
  }

  disconnectedCallback(): void {
    // A move in the page disconnects and reconnects the element. The hint
    // and the time already waited are kept, only the timer stops.
    this.clearTimer();
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (name === 'pending') {
      // Setting `pending` again while it is set is the same open request.
      if (oldValue !== null && newValue !== null) return;
      this.pendingSince = newValue === null ? null : Date.now();
      this.schedule();
    } else if (name === 'delay-ms') {
      this.schedule();
    } else if (this.hasAttribute('shown')) {
      this.render();
    }
  }

  private upgradeProperty(name: 'wallet' | 'pending'): void {
    if (!Object.prototype.hasOwnProperty.call(this, name)) return;
    const value: unknown = Reflect.get(this, name);
    Reflect.deleteProperty(this, name);
    Reflect.set(this, name, value);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private setShown(shown: boolean): void {
    if (shown === this.hasAttribute('shown')) return;
    if (shown) {
      // The text goes into the live region as the hint appears, so assistive
      // technology announces it then.
      this.setAttribute('shown', '');
      this.render();
    } else {
      this.removeAttribute('shown');
      this.titleEl.textContent = '';
      this.detailEl.textContent = '';
      this.markEl.replaceChildren();
    }
  }

  private schedule(): void {
    this.clearTimer();
    if (!this.pending) {
      this.pendingSince = null;
      this.setShown(false);
      return;
    }
    if (!this.isConnected || this.hasAttribute('shown')) return;
    this.pendingSince ??= Date.now();
    const wait = this.pendingSince + parseDelay(this.getAttribute('delay-ms')) - Date.now();
    this.timer = setTimeout(
      () => {
        this.timer = null;
        if (this.isConnected && this.pending) this.setShown(true);
      },
      Math.max(0, wait)
    );
  }

  private render(): void {
    const wallet = this.wallet;
    const { title, detail } = approvalHintText(wallet);
    this.titleEl.textContent = title;
    this.detailEl.textContent = detail;
    this.markEl.replaceChildren();
    if (wallet.icon !== null) {
      const img = document.createElement('img');
      img.src = wallet.icon;
      img.alt = '';
      this.markEl.append(img);
    } else {
      this.markEl.innerHTML = ICON_WALLET;
    }
  }
}

/** Registers `<qrl-approval-hint>` once. Safe to call repeatedly and outside a browser. */
export function defineQrlApprovalHint(): void {
  if (typeof customElements === 'undefined') return;
  if (!customElements.get(QRL_APPROVAL_HINT_TAG)) {
    customElements.define(QRL_APPROVAL_HINT_TAG, QrlApprovalHint);
  }
}

/**
 * Keeps a hint in step with a wallet's open requests: `pending` follows
 * `approvals.pending()`. Returns the function that ends the binding.
 */
export function bindApprovalHint(hint: QrlApprovalHint, approvals: ApprovalRequests): () => void {
  const sync = (): void => {
    hint.pending = approvals.pending();
  };
  sync();
  return approvals.subscribe(sync);
}
