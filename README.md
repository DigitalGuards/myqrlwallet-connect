# @qrlwallet/connect

Connect your dApp to QRL Wallet. Users scan a QR code (desktop) or tap a button (mobile) to pair their wallet, then approve transactions right from the app.

## How it works

1. Your dApp generates a connection URI and shows it as a QR code
2. User scans with the QRL Wallet app (or taps a deep link on mobile)
3. An encrypted channel is established through our relay server
4. Your dApp sends JSON-RPC requests, the wallet prompts for approval
5. Signed results come back to your dApp

All communication is end-to-end encrypted with ML-KEM-768 (FIPS 203) key encapsulation and AES-256-GCM. The relay server never sees your data.

## Install

```bash
npm install @qrlwallet/connect
```

## Quick start

```typescript
import { QRLConnect } from '@qrlwallet/connect';

const qrl = new QRLConnect({
  dappMetadata: {
    name: 'My QRL dApp',
    url: 'https://mydapp.com',
  },
});

// Get the connection URI
const uri = await qrl.getConnectionURI();

// Desktop: render as QR code (use any QR library)
// Mobile: redirect to open the wallet app
if (qrl.isMobile()) {
  window.location.href = uri;
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
  params: [{
    from: accounts[0],
    to: '0x...',
    value: '0x2386F26FC10000', // 0.01 QRL
  }],
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
  },

  // Optional
  relayUrl: 'https://qrlwallet.com',  // default relay
  chainId: '0x0',                      // QRL chain ID
  autoReconnect: true,                 // reconnect on page load (default: true)
  debug: false,                        // console logging
});
```

## API

### `QRLConnect`

The main class. Creates a connection manager and EIP-1193 provider.

| Method | Description |
|--------|-------------|
| `getConnectionURI()` | Returns the `qrlconnect://` URI for QR codes or deep links |
| `request({ method, params })` | Send a JSON-RPC request to the wallet |
| `isMobile()` | Check if the user is on a mobile browser |
| `getAppStoreUrl()` | Get the app store link for QRL Wallet |
| `isConnected()` | Whether the wallet is connected |
| `getAccounts()` | Get connected accounts |
| `getStatus()` | Current connection status |
| `hasStoredSession()` | Check if a reconnectable session exists in local storage |
| `newConnection()` | Reset current pairing and generate a new channel/URI |
| `disconnect()` | End the session |
| `getChannelId()` | Get the current relay channel ID (useful for debugging) |

### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `connect` | `{ chainId }` | Wallet connected |
| `disconnect` | `{ code, message }` | Wallet disconnected |
| `accountsChanged` | `string[]` | Account list changed |
| `chainChanged` | `string` | Chain switched |
| `statusChanged` | `ConnectionStatus` | Intermediate lifecycle states (see values below) |
| `connection_lost` | — | Emitted after 5 failed reconnection attempts |

#### `ConnectionStatus` values

| Value | Meaning |
|-------|---------|
| `disconnected` | No active connection |
| `connecting` | Connecting to relay server |
| `waiting` | QR displayed, waiting for wallet to scan |
| `key_exchange` | Post-quantum key exchange in progress |
| `connected` | Wallet connected, ready for requests |
| `reconnecting` | Attempting to restore a previous session |

### Supported RPC methods

**Require user approval:**
`qrl_requestAccounts`, `qrl_sendTransaction`, `qrl_signTransaction`, `qrl_signMessage`, `qrl_signTypedData`, `wallet_addQrlChain`, `wallet_switchQrlChain`

`qrl_signMessage` and `qrl_signTypedData` (v3.0.0) replace the Ethereum-flavored `personal_sign` / `qrl_sign` / `qrl_signTypedData_v3` / `qrl_signTypedData_v4`. Both use SHAKE256 + native ML-DSA-87 ctx and return a rich `{ signature, publicKey, signer, digest, schemeVersion }` object; verify locally with `verifyMessage` / `verifyTypedData` exported from this package.

**Auto-proxied (no approval needed):**
`qrl_getBalance`, `qrl_call`, `qrl_estimateGas`, `qrl_blockNumber`, `qrl_chainId`, `qrl_getTransactionReceipt`, and 30+ more read-only methods.

## Sessions

Sessions persist in `localStorage` for 7 days. When a user returns to your dApp, the SDK can automatically reconnect without requiring a new QR scan.

Recommended lifecycle:

- Use `hasStoredSession()` on page load to decide whether to show reconnect state/UI
- Keep a single `QRLConnect` instance for the page lifetime
- Use `newConnection()` when the user explicitly wants to pair a different wallet
- Use `statusChanged` for UI state transitions instead of relying on internals

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

> **Want to try it without any setup?** The same example is hosted live at [zondscan.com/dapp-example](https://zondscan.com/dapp-example) — it pairs with the production relay and MyQRLWallet mobile app out of the box.

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
  **transcript hash** derived from the full handshake (`LABEL || cid || pk || ct`)
- Session keys are established with **ML-KEM-768** (FIPS 203, NIST Level 3),
  carried in the QR code so the relay never sees an uncommitted public key
- Ciphertext tampering is detected exclusively at the AES-GCM tag;
  ML-KEM's implicit rejection is NOT used for authentication
- PIN or biometric authentication required for every transaction
- dApp URL is displayed to the user before connecting
- Unknown RPC methods are rejected with `-32601`

## License

MIT
