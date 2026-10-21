# @qrlwallet/connect-ui

Shared wallet connection helpers and the MyQRLWallet pairing dialog, for dApps using [`@qrlwallet/connect`](https://github.com/DigitalGuards/myqrlwallet-connect).

- `<qrl-pairing-modal>`: shadow-DOM custom element with the MyQRLWallet QRL Blue palette (deep navy, sky-blue accent, ice-blue links), themeable with CSS custom properties.
- `showPairingModal(provider)`: one-line helper that wires the modal to a connect provider and resolves when pairing finishes.
- `createExtensionSession(provider, handlers)`: extension approval, restore, lock recovery, and explicit permission revocation.
- Zero framework dependencies; works in React, Vue, Svelte and plain HTML alike. Only runtime dependency is the `qrcode` encoder.
- Relay UI consumes the SDK's public API. Extension sessions consume EIP-1193 account and permission methods. Relay keys and protocol live in `@qrlwallet/connect`.

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

## One MyQRLWallet row in the wallet picker

MyQRLWallet announces itself twice over EIP-6963: the browser extension announces
`com.qrlwallet.extension`, and `@qrlwallet/connect` announces
`com.qrlwallet.connect` for relay pairing with the phone, web and desktop
wallets. A picker that lists announcements as it receives them therefore shows
MyQRLWallet twice.

`groupMyQrlWallet()` folds the pair into one entry. It is pure data: no DOM, no
framework, no protocol surface, and it ships from the dependency-free
`@qrlwallet/connect-ui/wallets` subpath as well as the package index.

```ts
import { groupMyQrlWallet } from '@qrlwallet/connect-ui';

for (const entry of groupMyQrlWallet(announcements)) {
  if (entry.kind === 'myqrlwallet') {
    // One row: name "MyQRLWallet", the wallet mark as its icon.
    renderRow(entry.name, entry.icon, entry.primaryLabel, () =>
      connect(entry.primary === 'extension' ? entry.extension : entry.relay)
    );
    if (entry.secondary === 'relay') {
      // Extra button, e.g. "Use phone or desktop app".
      renderAction(entry.secondaryLabel, () => connect(entry.relay));
    }
  } else {
    renderRow(entry.name, entry.icon, entry.rdns, () => connect(entry.detail));
  }
}
```

The input is any iterable of EIP-6963 `announceProvider` details (only
`detail.info` is read; your own detail object travels through untouched on the
generic type). Output preserves announcement order, with the merged entry
sitting where the first MyQRLWallet announcement was, and every other wallet
passed through as `{ kind: 'wallet', uuid, name, icon, rdns, detail }`.

The merged entry:

| Field                           | Meaning                                                                                   |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| `kind`                          | Always `'myqrlwallet'`                                                                     |
| `uuid`                          | uuid of the announcement the primary click uses, so an existing uuid lookup keeps working  |
| `name`                          | `"MyQRLWallet"`, overridable                                                               |
| `icon`                          | The relay announcement's icon (the wallet mark), falling back to the extension's           |
| `extension` / `relay`           | The announcements themselves; each present only when that transport announced              |
| `primary`                       | `'extension'` when the extension announced, otherwise `'relay'`                            |
| `primaryLabel`                  | Plain secondary line: `"Browser extension"` or `"Phone, web or desktop"`                   |
| `secondary`                     | `'relay'` when both transports announced, otherwise `null`                                 |
| `secondaryLabel`                | `"Use phone or desktop app"` when `secondary` is set, otherwise `null`                     |

Options: `icon` overrides the row icon (for a locally hosted mark), `name`
overrides the display name.

Also exported: `resolveMyQrlWalletEntry(details, options?)` returns just the
merged entry (or `null`) for pickers that keep their own list shape,
`isMyQrlWalletRdns(rdns)` for filtering, and the constants
`MYQRLWALLET_EXTENSION_RDNS`, `MYQRLWALLET_CONNECT_RDNS`, `MYQRLWALLET_NAME`,
`MYQRLWALLET_EXTENSION_LABEL`, `MYQRLWALLET_RELAY_LABEL` and
`MYQRLWALLET_RELAY_ACTION_LABEL`.

Render the row as one button with the extra action as a second, separately
focusable button, so keyboard and screen-reader users reach both paths and the
accessible name of each says which one it takes.

## Extension sessions

Use `createExtensionSession` with the extension provider from an EIP-6963
announcement. It is exported from the package index and the DOM-free
`@qrlwallet/connect-ui/extension` subpath. Relay providers continue to use the
SDK and pairing modal APIs.

```ts
import { createExtensionSession } from '@qrlwallet/connect-ui/extension';
import { isCurrentQrlAddress } from '@qrlwallet/connect';

const session = createExtensionSession(detail.provider, {
  validateAccount: isCurrentQrlAddress, // Optional QIP-55 checksum validation.
  onStateChange(state) {
    renderConnection(state);
    setAccountActionsEnabled(state.status === 'connected');
    if (state.error) showWalletError(state.error.message);
  },
});

// Connect keeps its original request pending through unlock and approval.
connectButton.addEventListener('click', () => { void session.connect(); });

// Only an explicit Disconnect button requests permission revocation.
disconnectButton.addEventListener('click', () => { void session.disconnect(); });

// On page restoration, use the remembered extension's new announcement:
// await session.restore();

// Component teardown or switching providers performs local cleanup.
// session.dispose();
```

The buttons, render function, and error function above belong to your dApp. Create one session
for the selected extension and dispose the previous helper when selecting a
different provider. Persist the selected wallet's identifier only while
`state.intent` is true, and rediscover its provider before calling `restore()`.
The reference example uses session storage for this intent across page reloads.

The helper installs `accountsChanged`, `chainChanged`, and `disconnect`
listeners before requesting or probing accounts. Old listeners and pending
replies are guarded by session generation, including when the same provider
is selected again. New account events take precedence over older probe or
request responses. Provider `connect` events do not grant account access.

| State | Meaning and dApp behavior |
| --- | --- |
| `idle` | No connection intent yet. |
| `pending` | Awaiting `qrl_requestAccounts` or the `qrl_accounts` restore probe. Disable account actions. |
| `connected` | Valid accounts are available. Enable account actions. |
| `locked` | Accounts are empty. Keep the provider, subscriptions, and intent; disable account actions while the wallet is locked or the passive grant check is inconclusive. |
| `rejected` | Connect returned code `4001`, including dismissal or approval timeout. Show rejection and allow another Connect click. |
| `error` | Another request or invalid provider payload failed. Inspect `state.error` and allow a retry. |
| `disconnecting` | Explicit revocation is pending; account actions are disabled and old events are ignored. |
| `disconnected` | Local cleanup finished, the wallet removed access, or the provider emitted a permanent disconnect. Intent is false. Inspect `state.error` for failures. |

`accountsChanged([])` after connection enters `locked` and probes `qrl_accounts`.
An empty response retains the provider, listeners, and intent. Valid accounts
restore `connected`; code `4100` ends the session quietly as `disconnected`,
with `intent: false` and `error: null`. Other probe failures keep the locked
state. `restore()` also treats `4100` as a quiet disconnect. A newer account
event always wins over an older probe response or rejection.

MyQRLWallet extension 1.3.0 returns `[]` for every origin while locked. The
helper therefore cannot distinguish a lock from removed access while the
wallet is locked, by design. When unlocked, `qrl_accounts` returns the granted
accounts or `4100` for an ungranted origin. Lock/unlock account events recover
the connection without another click.

A fresh locked `connect()` waits for its original approval promise even if
unlock emits previously granted accounts; it has no retry loop or extra
timeout. Repeated Connect calls share that pending request. `connect()` can
supersede a pending restore. Provider `disconnect` code `1013` is recoverable
and preserves the session and its state. Other disconnect codes end the session.

The default account check requires uppercase `Q` followed by exactly 128 hex
digits, the QRL 2.0 text form. An invalid account rejects the entire list.
`handlers.validateAccount` optionally adds a check for every account in a
request, event, or probe. Pass the SDK's `isCurrentQrlAddress` to validate
mixed-case QIP-55 checksums; the UI helper has no runtime dependency on the SDK.

**Revocation happens only on explicit `disconnect()`.** It sends
`wallet_revokePermissions` with `params: [{ qrl_accounts: {} }]`. Code `-32601`
uses local cleanup as a compatibility fallback. Every other revocation error,
including `4200`, appears in the final disconnected state's `error`; local
cleanup still completes. A new Connect waits for an in-progress revocation
to finish. If Disconnect retires a pending approval, it revokes immediately
and resolves after that revocation, without waiting for approval. If the old
request later returns accounts, the helper revokes again. This cleanup survives
`dispose()` and keeps local state disconnected. A later `connect()` for the
same provider, including on a replacement helper, cancels the late revocation
so the new grant survives. Both revocation attempts are best effort; a late
failure is reported only while that disconnected helper remains active.
Locking preserves subscriptions. Permanent provider disconnect and `dispose()`
perform local cleanup; an earlier explicit Disconnect can still finish its
revocation.

`getState()` returns an immutable snapshot with `status`, `accounts`,
`chainId`, `intent`, and `error`. `chainId` is the most recent `chainChanged`
value, initially `null`; a dApp can separately request `qrl_chainId` when it
needs the initial chain. Errors contain `operation`, numeric `code` (or
`null`), `message`, and the original `cause`. `connect()`, `restore()`, and
`disconnect()` resolve to the current snapshot and report provider failures
through state. Pending `connect()` and `restore()` calls also settle on local
Disconnect, permanent provider disconnect, failure, supersession, or `dispose()`,
even if the provider never answers. Calls queued behind revocation settle on
disposal too. `onStateChange` runs synchronously and should not throw.
`dispose()` is terminal, clears local state, removes listeners, and silences
callbacks. Subsequent calls on a disposed helper return its disconnected
snapshot.

Exported types: `ExtensionSession`, `ExtensionSessionProvider`,
`ExtensionSessionEvent`, `ExtensionSessionStatus`, `ExtensionSessionState`,
`ExtensionSessionError`, and `ExtensionSessionHandlers`.

### Browser regression test

After building the SDK, UI, and example, run
`node scripts/extension-session-browser.mjs` with `QRL_EXTENSION_DIR` pointing
to an unpacked MyQRLWallet extension build. Set `QRL_EXTENSION_SOURCE` to its
source checkout containing the public E2E fixture. The test imports Playwright
from `PLAYWRIGHT_MODULE` (defaults to `playwright/test`); `CHROMIUM_EXECUTABLE` can
select an installed Chromium. `QRL_BROWSER_REPORT` optionally selects the JSON
report path. It uses a temporary browser profile, a public test account, and
a local RPC fixture. It exercises pending locked approval, late approval after
page Disconnect, lock/unlock and reload recovery, page revocation, and
extension-side disconnect followed by reload. Revocation checks cover both
`qrl_accounts` returning `4100` and the extension's connected-sites view.

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
