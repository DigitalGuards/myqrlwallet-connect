# @qrlwallet/connect-ui

The MyQRLWallet pairing dialog as a framework-free web component, for dApps using [`@qrlwallet/connect`](https://github.com/DigitalGuards/myqrlwallet-connect). One import replaces the QR modal every dApp used to hand-copy.

- `<qrl-pairing-modal>`: shadow-DOM custom element, themeable with CSS custom properties, dark MyQRLWallet look by default.
- `showPairingModal(provider)`: one-line helper that wires the modal to a connect provider and resolves when pairing finishes.
- Zero framework dependencies; works in React, Vue, Svelte and plain HTML alike. Only runtime dependency is the `qrcode` encoder.
- Purely presentational: consumes only the SDK's public API and contains no cryptography. Keys, sessions and protocol live in `@qrlwallet/connect`.

## Install

```bash
npm install @qrlwallet/connect @qrlwallet/connect-ui
```

## Quick start

```ts
import { QRLConnect } from '@qrlwallet/connect';
import { showPairingModal } from '@qrlwallet/connect-ui';

const provider = new QRLConnect({
  dappMetadata: { name: 'My dApp', url: location.origin },
  autoReconnect: true,
});

const result = await showPairingModal(provider);
// 'connected'  -> handshake completed, start using provider.request()
// 'cancelled'  -> user dismissed the dialog
// 'redirected' -> mobile browser navigated to the wallet deep link

if (result === 'connected') {
  const accounts = await provider.request({ method: 'qrl_requestAccounts' });
}
```

`showPairingModal` reuses a stored session URI when one exists. To force a fresh pairing (tear down the old channel and rotate keys), pass `{ fresh: true }`; wire that to your "New connection" affordance outside the modal if you have one. Inside the modal the New connection action already rotates in place.

### Options

| Option | Default | Meaning |
|---|---|---|
| `fresh` | `false` | Start from `newConnection()` instead of the stored session URI |
| `walletName` | `"MyQRLWallet"` | Dialog title branding |
| `walletUrl` | `https://myqrlwallet.com` | Get-the-wallet link under the title (mobile + desktop downloads; the web wallet cannot pair from a plain browser tab) |
| `container` | `document.body` | Mount point for the modal element |
| `mobileRedirect` | `true` | On mobile browsers navigate straight to the `qrlconnect://` deep link instead of showing a QR |

## Using the element directly

If you manage the pairing lifecycle yourself (as the existing dApps do with their `useQrlWallet`-style hooks), render the element and feed it attributes:

```ts
import { defineQrlPairingModal } from '@qrlwallet/connect-ui';

defineQrlPairingModal();
```

```html
<qrl-pairing-modal
  uri="qrlconnect://pair?..."
  status="waiting"
></qrl-pairing-modal>
```

Attributes: `uri`, `status`, `wallet-name`, `wallet-url`. Events (bubbling, composed): `qrl-new-connection` when the user asks for a fresh pairing, `qrl-cancel` when the dialog is dismissed (Cancel action, Escape, or backdrop click). The element renders nothing outside its own box: mount and remove it to show and hide.

## Theming

Set CSS custom properties on the element or any ancestor:

| Property | Default | Role |
|---|---|---|
| `--qrl-modal-accent` | `#f97316` | Left card border, hover + focus accents |
| `--qrl-modal-bg` | `#0f172a` | Card background |
| `--qrl-modal-fg` | `#e2e8f0` | Primary text |
| `--qrl-modal-muted` | `#94a3b8` | Secondary text |
| `--qrl-modal-link` | `#38bdf8` | Links and link-style buttons |
| `--qrl-modal-border` | `rgba(148,163,184,.25)` | Card + button borders |
| `--qrl-modal-radius` | `12px` | Card corner radius |
| `--qrl-modal-backdrop` | `rgba(2,6,23,.8)` | Backdrop overlay |
| `--qrl-modal-font` | system stack | Font family |
| `--qrl-modal-z` | `2147483000` | Backdrop z-index |

## Accessibility

`role="dialog"` with `aria-modal`, labelled title, focus moved into the dialog on open and restored on close, Tab focus trap, Escape to dismiss, `aria-live` status line.

## Why a separate package

The core SDK keeps a small, auditable, crypto-fenced surface. UI code and the QR encoder dependency deliberately live here instead, so dApps that build their own pairing UI never pull them in.

## License

MIT
