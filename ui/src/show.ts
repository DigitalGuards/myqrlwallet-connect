// showPairingModal(): the one-line integration. Wires a <qrl-pairing-modal>
// to a connect provider using only its public API (getConnectionURI,
// newConnection, isMobile, connect/statusChanged events), so this package
// adds no protocol surface.

import { defineQrlPairingModal, isPairingUri, QrlPairingModal } from './element.js';

/**
 * Structural subset of QRLConnectProvider that the modal needs. Kept
 * duck-typed so @qrlwallet/connect stays an optional peer dependency;
 * a compile-time test asserts the real provider satisfies it.
 */
export interface PairingProvider {
  /** Returns the pairing URI, reusing a stored session when available. */
  getConnectionURI(): Promise<string>;
  /** Tears down the existing pairing and rotates to a fresh channel/keys. */
  newConnection(): Promise<string>;
  isMobile(): boolean;
  on(event: 'connect', listener: (info: { chainId: string }) => void): unknown;
  on(event: 'statusChanged', listener: (status: string) => void): unknown;
  off(event: 'connect', listener: (info: { chainId: string }) => void): unknown;
  off(event: 'statusChanged', listener: (status: string) => void): unknown;
}

export type PairingResult = 'connected' | 'cancelled' | 'redirected';

export interface ShowPairingOptions {
  /** Tear down any existing pairing and rotate channel/keys first. */
  fresh?: boolean;
  /** Shown in the dialog title. Default "MyQRLWallet". */
  walletName?: string;
  /** Web wallet link under the title. Default https://qrlwallet.com. */
  walletUrl?: string;
  /** Where to mount the modal. Default document.body. */
  container?: HTMLElement;
  /**
   * On mobile browsers navigate straight to the qrlconnect:// deep link
   * instead of showing a QR (the wallet app opens in the foreground).
   * Default true.
   */
  mobileRedirect?: boolean;
}

/**
 * Shows the pairing dialog and resolves when the pairing reaches a
 * terminal state: 'connected' (handshake completed), 'cancelled' (user
 * dismissed the dialog), or 'redirected' (mobile deep-link navigation;
 * the page is likely being backgrounded).
 */
export async function showPairingModal(
  provider: PairingProvider,
  options: ShowPairingOptions = {}
): Promise<PairingResult> {
  const uri =
    options.fresh === true ? await provider.newConnection() : await provider.getConnectionURI();

  if ((options.mobileRedirect ?? true) && provider.isMobile()) {
    // Never navigate to anything but the wallet's own scheme; a URI this
    // malformed means the provider is broken, so fail loudly.
    if (!isPairingUri(uri)) {
      throw new Error('refusing to redirect: pairing URI does not use the qrlconnect: scheme');
    }
    window.location.href = uri;
    return 'redirected';
  }

  defineQrlPairingModal();
  const modal = new QrlPairingModal();
  modal.setAttribute('uri', uri);
  if (options.walletName !== undefined) modal.setAttribute('wallet-name', options.walletName);
  if (options.walletUrl !== undefined) modal.setAttribute('wallet-url', options.walletUrl);
  const container = options.container ?? document.body;

  return new Promise<PairingResult>((resolve) => {
    let settled = false;

    const onStatus = (status: string): void => {
      modal.setAttribute('status', status);
    };
    const onConnect = (): void => {
      finish('connected');
    };

    function finish(result: PairingResult): void {
      if (settled) return;
      settled = true;
      provider.off('connect', onConnect);
      provider.off('statusChanged', onStatus);
      modal.remove();
      resolve(result);
    }

    modal.addEventListener('qrl-cancel', () => {
      finish('cancelled');
    });
    modal.addEventListener('qrl-new-connection', () => {
      modal.setAttribute('status', 'rotating…');
      void provider
        .newConnection()
        .then((fresh) => {
          if (!settled) modal.setAttribute('uri', fresh);
        })
        .catch((err: unknown) => {
          if (!settled) {
            modal.setAttribute(
              'status',
              err instanceof Error ? err.message : 'could not rotate the connection'
            );
          }
        });
    });

    provider.on('statusChanged', onStatus);
    provider.on('connect', onConnect);
    container.appendChild(modal);
  });
}
