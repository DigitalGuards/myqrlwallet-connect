# @qrlwallet/connect

Connect your dApp to QRL Wallet. Users scan a QR code (desktop) or tap a button (mobile) to pair their wallet, then approve transactions right from the app.

## Version 5 migration

Version 5 requires QIP-55 addresses: `Q` followed by 128 hexadecimal characters.
Account validation and message-signature verification use the complete 64-byte
address. Applications using legacy 20-byte addresses must remain on version 4
until their network and wallet support QIP-55.

Wallet typed-data requests are disabled pending a versioned 64-byte address
encoding. The local verifier remains available for address-free typed data.
The private v3 network is a test network; its availability does not establish
compatibility with legacy deployments or contracts.

## How it works

1. Your dApp generates a connection URI and shows it as a QR code
2. User scans with the QRL Wallet app (or taps a deep link on mobile)
3. An encrypted channel is established through our relay server
4. Your dApp sends JSON-RPC requests, the wallet prompts for approval
5. Signed results come back to your dApp

All application traffic is end-to-end encrypted with ML-KEM-768 (FIPS 203)
key encapsulation and AES-256-GCM. PQP3 adds a fresh 32-byte pairing
capability to every QR/deep link. The relay serves the dApp public key, but it
never receives that capability or application plaintext.

## Install

```bash
npm install @qrlwallet/connect
```

Package installation and source builds require Node.js 20.19.0 or newer because
the direct cryptography dependencies use that engine floor. Browser execution
requires Web Crypto.

Want a ready-made pairing dialog (QR code, deep link, copy-code fallback) instead of building your own? Add the framework-free [`@qrlwallet/connect-ui`](ui/) web component.

## Quick start

```typescript
import { QRLConnect, attemptWalletRedirect, getAppStoreUrl } from '@qrlwallet/connect';

const qrl = new QRLConnect({
  dappMetadata: {
    name: 'My QRL dApp',
    url: 'https://mydapp.com',
  },
});

// Get the connection URI
const uri = await qrl.getConnectionURI();

// Desktop: render as QR code (use any QR library)
// Mobile: try to open the wallet app, with a fallback for when it is
// not installed (a bare `window.location.href = uri` fails at the
// unknown protocol: silently on Android, blocking alert on iOS)
if (qrl.isMobile()) {
  const opened = await attemptWalletRedirect(uri);
  if (!opened) {
    // Wallet app not installed (or the user dismissed the chooser):
    // show your QR / copy-code pairing UI plus an install link.
    console.log('Get MyQRLWallet:', getAppStoreUrl());
  }
} else {
  // render uri as QR code
}

// Listen for connection
qrl.on('connect', ({ chainId }) => {
  console.log('Wallet connected on chain', chainId);
});

qrl.on('accountsChanged', (accounts) => {
  console.log('Connected accounts:', accounts);
});

qrl.on('statusChanged', (status) => {
  console.log('Connection status:', status);
});

// Use as an EIP-1193 provider
const accounts = await qrl.request({ method: 'qrl_requestAccounts' });

const txHash = await qrl.request({
  method: 'qrl_sendTransaction',
  params: [
    {
      from: accounts[0],
      to: 'Q22222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222',
      value: '0x2386F26FC10000', // 0.01 QRL
    },
  ],
});
```

## Configuration

```typescript
const qrl = new QRLConnect({
  // Required
  dappMetadata: {
    name: 'QuantaPool',
    url: 'https://quantapool.com',
    icon: 'https://quantapool.com/icon.png', // optional
    redirectUrl: 'https://quantapool.com/return', // optional
  },

  // Optional
  relayUrl: 'https://qrlwallet.com', // default relay
  chainId: '0x0', // QRL chain ID
  autoReconnect: true, // reconnect on page load (default: true)
  walletRedirectOnRequest: true, // mobile: deep-link the wallet app awake
  // for approval requests (default: true)
  debug: false, // console logging
});
```

`dappMetadata.url` and optional `redirectUrl` are canonicalized
credential-free HTTP(S) URLs. HTTPS is required except on an explicit
`localhost`, `.localhost`, `127.0.0.1`, or `[::1]` development hostname. A
custom app scheme is not accepted as a return target.

## API

### `QRLConnect`

The main class. Creates a connection manager and EIP-1193 provider.

| Method                        | Description                                                         |
| ----------------------------- | ------------------------------------------------------------------- |
| `getConnectionURI()`          | Retires any prior pairing and returns a fresh `qrlconnect://` URI   |
| `request({ method, params })` | Send a JSON-RPC request to the wallet                               |
| `isMobile()`                  | Check if the user is on a mobile browser                            |
| `getAppStoreUrl()`            | Get the app store link for QRL Wallet                               |
| `isConnected()`               | Whether the wallet is connected                                     |
| `isPaired()`                  | Whether a pairing exists, even while the wallet app is backgrounded |
| `isWalletPresent()`           | Whether the wallet is currently live in the relay channel           |
| `getAccounts()`               | Get connected accounts                                              |
| `getStatus()`                 | Current connection status                                           |
| `hasStoredSession()`          | Check if a reconnectable session exists in local storage            |
| `newConnection()`             | Reset current pairing and generate a new channel/URI                |
| `disconnect()`                | End the session                                                     |
| `getChannelId()`              | Get the current relay channel ID (useful for debugging)             |

### Events

| Event             | Payload             | Description                                      |
| ----------------- | ------------------- | ------------------------------------------------ |
| `connect`         | `{ chainId }`       | Wallet connected                                 |
| `disconnect`      | `{ code, message }` | Wallet disconnected                              |
| `accountsChanged` | `string[]`          | Account list changed                             |
| `chainChanged`    | `string`            | Chain switched                                   |
| `statusChanged`   | `ConnectionStatus`  | Intermediate lifecycle states (see values below) |
| `connection_lost` | (none)              | Emitted after 5 failed reconnection attempts     |

#### `ConnectionStatus` values

| Value          | Meaning                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------ |
| `disconnected` | No active connection                                                                             |
| `connecting`   | Connecting to relay server                                                                       |
| `waiting`      | Waiting for the wallet: a first scan, or (when `isPaired()`) a backgrounded wallet app to return |
| `key_exchange` | Post-quantum key exchange in progress                                                            |
| `connected`    | Wallet connected, ready for requests                                                             |
| `reconnecting` | Attempting to restore a previous session                                                         |

### Supported RPC methods

**Require user approval:**
`qrl_requestAccounts`, `qrl_sendTransaction`, `qrl_signTransaction`, `qrl_signMessage`, `qrl_signTypedData`, `wallet_switchQrlChain`

`qrl_signMessage` uses SHAKE256 plus native ML-DSA-87 ctx and returns a rich `{ signature, publicKey, descriptor, signer, digest, schemeVersion }` object. During the QIP-55 port, `qrl_signTypedData` stays in the approval policy and fails locally before relay use. Its v1 encoding fixes addresses to a 32-byte slot, so a new 64-byte encoding needs a new scheme version and regenerated wallet parity vectors.

`request()` returns `unknown`. First validate the exact response shape with
`isQrlSignedMessageResult` or `isQrlSignedTypedDataResult`, then require
`hasSigningDescriptor`. PQP3 authenticates the paired transport session. It
does not prove that the returned ML-DSA signature is valid or that its public
key belongs to the claimed signer. Authentication and authorization flows must
call `verifyMessageForSigner` or the historical v1 `verifyTypedDataForSigner`
with the original challenge or payload and the expected QIP-55 Q + 128 hex
address.

The lower-level `verifyMessageSignature` / `verifyTypedDataSignature` helpers
verify only the supplied key and signature; they do not prove that the key
belongs to a claimed signer. The old `verifyMessage` / `verifyTypedData` names
remain as deprecated aliases. `descriptor` remains optional in the response
type for older-wallet compatibility. Strict shape guards accept its absence,
while `hasSigningDescriptor` and both bound verifiers fail closed.

Approval-bound calls are serialized. Unknown methods and direct node mutation
surfaces such as `qrl_sendRawTransaction` and `wallet_addQrlChain` are rejected
locally. Signing and transaction calls also fail locally until exactly one
account has been approved by `qrl_requestAccounts`. Their signer or `from`
field must exactly match that approved address.

**Auto-proxied (no approval needed):**
`qrl_chainId`, `qrl_blockNumber`, `qrl_getBalance`,
`qrl_getTransactionCount`, `qrl_getBlockByNumber`,
`qrl_getTransactionReceipt`, `qrl_call`, `qrl_estimateGas`, `qrl_gasPrice`,
`qrl_getCode`, `qrl_getLogs`, `net_version`, and `net_listening`.

`qrl_accounts` is a wallet-local authorization read. It returns `[]` until
`qrl_requestAccounts` succeeds and is never forwarded to hosted node RPC.
An account string is not proof of control. For authentication, request a fresh
challenge with `qrl_signMessage` and verify it with `verifyMessageForSigner`.

## Address display

Use `formatQrlAddressFingerprint(address)` for compact QRL account labels. It
preserves checksum case and shows the first, exact middle, and final 8 hex
characters. Keep the complete raw address in links, clipboard values, QR codes,
RPC requests, and signing payloads.

```typescript
const label = formatQrlAddressFingerprint(account);
// Q11111111...33333333...55555555
```

## Sessions

Established v5 sessions persist in `localStorage` for 7 days. When a user
returns to your dApp, the SDK can automatically reconnect without requiring a
new QR scan. Pairing capabilities are never persisted. An exclusive Web Lock
gives one browser tab ownership of the persisted key and AEAD counters. A
second tab cannot restore or use that stream. Browsers without Web Locks use a
memory-only session and require a fresh pairing after reload.

Malformed handshake frames and ambiguous relay acknowledgements retire the
affected pairing. A fresh QR starts a new key, channel, and request generation;
pending work from the prior wallet is rejected locally, and the old relay
channel must be tombstoned before the new bearer capability is issued.

A paired session also survives the wallet app being backgrounded or closed. On the same device at most one of the two apps is ever foregrounded, so the wallet's socket being absent is the normal steady state of a mobile flow, not an error:

- `request()` still works while the wallet is away: the relay buffers the encrypted request for up to 5 minutes and the wallet drains it when it re-joins.
- On mobile browsers, an approval-needing request also fires a `qrlconnect://` deep link that brings the wallet app to the foreground (disable with `walletRedirectOnRequest: false`). `qrl_requestAccounts` never redirects: dApps call it on page load without a user gesture.
- Use `isPaired()` to tell "wallet away, session intact" apart from "never paired" when `getStatus()` is not `connected`.

Recommended lifecycle:

- Use `hasStoredSession()` on page load to decide whether to show reconnect state/UI
- Keep a single `QRLConnect` instance for the page lifetime
- Use `newConnection()` when the user explicitly wants to pair a different wallet
- Use `statusChanged` for UI state transitions instead of relying on internals
- On a `disconnect` event, check `hasStoredSession()`: if a session is still stored the wallet is merely unreachable (revived by any request); only re-pair when it is gone

## How the relay works

The relay is a lightweight Socket.IO server that routes encrypted messages between your dApp and the wallet. It runs at `wss://qrlwallet.com/relay`.

- Messages are end-to-end encrypted with AES-256-GCM keyed from an ML-KEM-768 handshake (the relay sees only ciphertext)
- Max 2 participants per channel
- Messages are buffered for up to 5 minutes if the wallet is temporarily offline (e.g., app backgrounded)
- Channels auto-expire after 30 minutes of inactivity

## Self-hosting the relay

The relay is part of [myqrlwallet-backend](https://github.com/DigitalGuards/myqrlwallet-backend). To use your own:

```typescript
const qrl = new QRLConnect({
  dappMetadata: { name: 'My dApp', url: 'https://mydapp.com' },
  relayUrl: 'https://my-relay-server.com',
});
```

Relay URLs must use HTTPS. Plain HTTP is accepted only for an explicit
`localhost`, `.localhost`, `127.0.0.1`, or `[::1]` development endpoint. Relay
URLs identify an origin only: credentials, paths, query strings, and fragments
are rejected before the URL can be logged, connected, or embedded in a QR.

## Development

```bash
# Build (CJS + ESM + .d.ts)
npm run build

# Watch mode (rebuilds on change)
npm run dev

# Type-check
npm run typecheck

# Unit tests (vitest)
npm test

# Lint
npm run lint

# E2E test (starts a local relay, simulates dApp + wallet handshake)
node test-e2e.mjs
```

## Running the example dApp

The `example/` directory contains a Vite test dApp with QR code generation, transaction sending, message signing, and read-only RPC calls.

> **Want to try it without any setup?** The same example is hosted live at [zondscan.com/dapp-example](https://zondscan.com/dapp-example): it pairs with the production relay and MyQRLWallet mobile app out of the box.

```bash
# 1. Build the SDK first (the example links to it locally)
npm run build

# 2. Install example dependencies
cd example && npm install

# 3. Start the dev server (opens http://localhost:5174)
npm run dev
```

The example connects to the production relay at `wss://qrlwallet.com/relay` by default. To use a local relay, start `myqrlwallet-backend` and change `RELAY_URL` in `example/main.js`.

## Security

- Private keys and seeds never leave the wallet
- All relay traffic is end-to-end encrypted with **AES-256-GCM** bound to a
  **transcript hash** derived from the full handshake
  (`"pq-pair/v3" || cid || pk || ct || capability`)
- Session keys are established with **ML-KEM-768** (FIPS 203, NIST Level 3),
  with the public key uploaded to the relay and pinned by a full 32-byte
  capability-bound fingerprint in the QR
- The PQP3 capability is a bearer secret. Do not log, persist, cache, or send
  a pairing URI to analytics. Retire the channel when a pairing UI is cancelled
- Ciphertext tampering is detected exclusively at the AES-GCM tag;
  ML-KEM's implicit rejection is NOT used for authentication
- PIN or biometric authentication required for every transaction
- dApp name and URL are displayed as unverified, dApp-supplied metadata
- Unknown RPC methods are rejected locally before a relay round trip

## License

MIT
