# @qrlwallet/connect-ui

The MyQRLWallet pairing dialog as a framework-free web component, for dApps using [`@qrlwallet/connect`](https://github.com/DigitalGuards/myqrlwallet-connect). One import replaces the QR modal every dApp used to hand-copy.

- `<qrl-pairing-modal>`: shadow-DOM custom element with the MyQRLWallet QRL Blue palette (deep navy, sky-blue accent, ice-blue links), themeable with CSS custom properties.
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

`showPairingModal` always obtains a fresh pairing URI. The provider tombstones
any prior channel before rotating its key and PQP3 capability. The `fresh`
option remains for integrations that explicitly want to call
`newConnection()`; both entry points retire older pairing material. Inside the
modal the New connection action rotates in place.

Cancelling is also a protocol action: the helper awaits `provider.disconnect()`
before resolving `"cancelled"` or removing the modal. This makes the displayed
URI unusable instead of leaving an unconsumed bearer capability alive until
relay expiry.

### Options

| Option           | Default                   | Meaning                                                                                                 |
| ---------------- | ------------------------- | ------------------------------------------------------------------------------------------------------- |
| `fresh`          | `false`                   | Use the explicit `newConnection()` rotation entry point                                                 |
| `walletName`     | `"MyQRLWallet"`           | Dialog title branding                                                                                   |
| `walletUrl`      | `https://myqrlwallet.com` | Get-the-wallet link under the title (app downloads; intentionally a different host than `webWalletUrl`) |
| `webWalletUrl`   | `https://qrlwallet.com`   | Base URL for the "Open web wallet" action; pass `''` to hide it                                         |
| `container`      | `document.body`           | Mount point for the modal element                                                                       |
| `mobileRedirect` | `true`                    | On mobile browsers navigate straight to the `qrlconnect://` deep link instead of showing a QR           |

## Using the element directly

If you manage the pairing lifecycle yourself (as the existing dApps do with their `useQrlWallet`-style hooks), render the element and feed it attributes:

```ts
import { defineQrlPairingModal } from '@qrlwallet/connect-ui';

defineQrlPairingModal();
```

```html
<qrl-pairing-modal uri="qrlconnect://pair?..." status="waiting"></qrl-pairing-modal>
```

Attributes: `uri`, `status`, `wallet-name`, `wallet-url`, `web-wallet-url` (absent = default web wallet, empty string = hide the action). Events (bubbling, composed): `qrl-new-connection` when the user asks for a fresh pairing, `qrl-cancel` when the dialog is dismissed (header close button, Cancel action, Escape, or backdrop click). When using the element directly, handle `qrl-cancel` by awaiting `provider.disconnect()` before removal. The element renders nothing outside its own box: mount and remove it to show and hide.

### The web-wallet handoff link

"Open web wallet" opens `<web-wallet-url>/dapp-sessions#qrlconnect=<encodeURIComponent(uri)>` in a new tab; the wallet reads the fragment, scrubs it from the address bar, and asks the user to approve. The URI travels in the URL fragment so it never reaches any server. If you build this link yourself, the `encodeURIComponent` step is mandatory: an un-encoded URI truncates at its first `&` or `#`. Requires a wallet deployment that reads the fragment; older deployments ignore it entirely (no pairing starts, and the URI lingers in the address bar), which is why the wallet ingress ships first.

PQP3 pairing URIs contain a 32-byte bearer capability. Never log them, place
them in local storage, include them in analytics or error reporting, or put
them in a normal query string. The fragment handoff above is safe only when
the wallet page reads and scrubs it immediately. A copied URI remains usable
until its relay channel is paired, cancelled, rotated, or expired.

## Theming

Set CSS custom properties on the element or any ancestor:

| Property                   | Default                                          | Role                                     |
| -------------------------- | ------------------------------------------------ | ---------------------------------------- |
| `--qrl-modal-accent`       | `hsl(199 78% 55%)`                               | Sky-blue mark icon and keyboard focus    |
| `--qrl-modal-bg`           | `hsl(222 38% 9%)`                                | Navy card background                     |
| `--qrl-modal-fg`           | `hsl(210 30% 96%)`                               | Primary text                             |
| `--qrl-modal-muted`        | `hsl(215 15% 66%)`                               | Secondary text                           |
| `--qrl-modal-link`         | `hsl(196 60% 78%)`                               | Ice-blue links and button hover accents  |
| `--qrl-modal-border`       | `hsl(220 30% 17%)`                               | Card, section and button borders         |
| `--qrl-modal-radius`       | `12px`                                           | Card corner radius                       |
| `--qrl-modal-backdrop`     | `rgb(0 0 0 / 70%)`                               | Backdrop overlay                         |
| `--qrl-modal-font`         | Instrument Sans Variable, then system sans-serif | Body font family                         |
| `--qrl-modal-heading-font` | Sora Variable, then body font                    | Heading font family                      |
| `--qrl-modal-width`        | `24rem`                                          | Maximum dialog width                     |
| `--qrl-modal-z`            | `2147483000`                                     | Backdrop z-index                         |

Fonts use the host page's installed font faces and fall back to system fonts. The kit makes no font requests. On short screens, the dialog scrolls within the viewport and keeps its actions reachable. QR codes retain black modules on a white background in every theme.

The public properties inherit from ancestors as well as accepting element overrides:

```css
:root {
  --qrl-modal-bg: hsl(var(--popover));
  --qrl-modal-fg: hsl(var(--foreground));
  --qrl-modal-link: hsl(var(--identity-accent));
  --qrl-modal-font: var(--font-sans);
}
```

## Accessibility

`role="dialog"` with `aria-modal`, labelled title, focus moved into the dialog on open and restored on close, Tab focus trap, Escape to dismiss, `aria-live` status line.

## Why a separate package

The core SDK keeps a small, auditable, crypto-fenced surface. UI code and the QR encoder dependency deliberately live here instead, so dApps that build their own pairing UI never pull them in.

## License

MIT
