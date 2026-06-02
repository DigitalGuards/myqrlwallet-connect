# CLAUDE.md

## Project Overview

QRL Connect (`@qrlwallet/connect`) is a self-hosted, end-to-end encrypted dApp-to-mobile-wallet protocol for the QRL network — the Quantum Resistant Ledger's EVM-compatible chain. It lets any QRL dApp show a QR code or deep link that users scan with the MyQRLWallet mobile app to connect their wallet, approve transactions, and sign messages remotely.

We built this instead of using WalletConnect because WalletConnect v2 requires Reown cloud infrastructure and third-party wallets that can't handle Q-addresses. Since we control both the dApp SDK and the wallet, a custom self-hosted protocol gives us full control over the transport layer — which is why QRL Connect ships with a post-quantum (ML-KEM-768) channel rather than the classical ECDH primitives WalletConnect uses.

## Architecture & Flow

```
┌─────────────────────┐                  ┌──────────────────────────┐
│  External dApp      │    Socket.IO     │  MyQRLWallet App         │
│                     │    (E2E          │  ┌──────────────────┐   │
│  @qrlwallet/connect │    encrypted)    │  │ Native: QR scan  │   │
│  - QR code / deep   │ <=============> │  │ + deep links     │   │
│    link generation   │                  │  └────────┬─────────┘   │
│  - EIP-1193 provider│                  │           │ bridge       │
└─────────────────────┘                  │  ┌────────▼─────────┐   │
           │                             │  │ WebView: Socket   │   │
   ┌───────▼───────┐                     │  │ client, ML-KEM,   │   │
   │ Relay Server   │                    │  │ signing, approval │   │
   │ (qrlwallet.com)│                    │  │ UI, sessions      │   │
   │ Socket.IO rooms│                    │  └──────────────────┘   │
   └────────────────┘                    └──────────────────────────┘
```

### SDK (`@qrlwallet/connect`)

The npm package dApp developers install. Generates `qrlconnect://` URIs (for QR codes on desktop, deep links on mobile), manages the Socket.IO connection to the relay, runs the ML-KEM-768 handshake, and exposes a standard EIP-1193 `provider.request()` interface so dApps interact with it exactly like a browser extension wallet.

Key files:
- `src/QRLConnectProvider.ts` — EIP-1193 provider with pending request tracking and timeout
- `src/ConnectionManager.ts` — Orchestrates socket, key exchange, encryption, session persistence
- `src/KeyExchange.ts` — 3-step SYN/SYNACK/ACK handshake
- `src/PQCrypto.ts` — ML-KEM-768 (FIPS 203) + AES-256-GCM AEAD, via `@noble/post-quantum` and WebCrypto
- `src/SocketClient.ts` — Socket.IO client with auto-reconnect
- `src/config.ts` — Restricted vs unrestricted RPC method lists, timeouts, defaults
- `src/utils/qrUri.ts` — URI generation and parsing

### Relay Server

Lives in `myqrlwallet-backend/src/relay/`. Stateless Socket.IO message router — it never sees plaintext, only encrypted ciphertext. Two files:

- `relayServer.js` — Socket.IO server config, event handlers (`join_channel`, `message`, `leave_channel`), rate limiting (100 msgs/min/IP)
- `channelManager.js` — Channel lifecycle, max 2 participants per channel, message buffering (50 msgs, 5-min TTL) for when the mobile app is backgrounded

The relay buffers messages when one participant disconnects (e.g., phone goes to sleep). When the participant reconnects and re-joins the channel, buffered messages are delivered immediately.

### Transport Layer

Uses ML-KEM-768 (FIPS 203, NIST Level 3) for key encapsulation and AES-256-GCM for message encryption, via `@noble/post-quantum` and WebCrypto. The session key is bound to the full handshake transcript (`LABEL || cid || pk || ct`) so ML-KEM's malicious-peer unknown-key-share vulnerabilities can't produce an agreement with inconsistent identities across sessions. The 3-step handshake:

1. **SYN**: dApp sends its ML-KEM-768 public key to the wallet via the relay
2. **SYNACK**: Wallet encapsulates a shared secret to the dApp's public key and returns the KEM ciphertext
3. **ACK**: dApp decapsulates, derives the AEAD key from the transcript, and confirms — both sides can now encrypt messages to each other

After key exchange, all JSON-RPC messages are encrypted with AES-256-GCM before being sent through the relay. The relay only ever sees base64 ciphertext. Tampering is detected exclusively at the AEAD tag — ML-KEM's FIPS 203 implicit rejection (which returns a pseudo-random secret on bad ciphertext) is NOT used for authentication.

### Mobile Integration

All approval UI, transaction signing, and ML-KEM/AES-GCM encryption happen inside the React Native WebView (not native code). This keeps seeds and private keys entirely within the WebView JavaScript context — they never cross the native bridge. The native app's role is minimal: QR scanning, receiving `qrlconnect://` deep links, and switching to the WebView tab when an approval modal needs to appear.

Relevant wallet-side code lives in `myqrlwallet-frontend/src/services/dappConnect/` and `myqrlwallet-frontend/src/components/Core/Body/DAppConnect/`.

### Hosted Example (`zondscan.com/dapp-example`)

The `example/` directory is not just a local test harness — it's also publicly hosted as a live demo on ZondScan. Any change you merge here under `example/` will appear on `zondscan.com/dapp-example` the next time that explorer redeploys (its `prebuild` hook clones this repo, builds the example, and stages `dist/` into its `public/dapp-example/`). Treat copy, styling, and behavior in `example/` as user-facing.

`RELAY_URL` in `example/main.js` is hardcoded to `https://qrlwallet.com` so the hosted example works out of the box. Edit the constant when running locally against a dev backend.

## Essential Commands

```bash
# Build the SDK (CJS + ESM + .d.ts via tsup)
npm run build

# Type-check without emitting
npm run typecheck

# Run the headless E2E test (starts relay on port 3001,
# simulates dApp + wallet, verifies key exchange + encrypted JSON-RPC)
node test-e2e.mjs

# Run the example Vite test dApp (needs backend relay running first)
cd example && npm install && npm run dev
# Opens at http://localhost:5174

# Start the backend relay for local development
cd ../myqrlwallet-backend && npm run dev
# Relay available at http://localhost:3000/relay
```

## File Structure

```
qrlwallet-connect/
├── src/
│   ├── index.ts               # Public API exports
│   ├── QRLConnectProvider.ts   # EIP-1193 provider
│   ├── ConnectionManager.ts    # Connection orchestrator
│   ├── KeyExchange.ts          # SYN/SYNACK/ACK handshake
│   ├── PQCrypto.ts             # ML-KEM-768 + AES-256-GCM
│   ├── SocketClient.ts         # Socket.IO client
│   ├── config.ts               # Constants, method lists
│   ├── types.ts                # All TypeScript types/enums
│   └── utils/
│       ├── qrUri.ts            # URI generation/parsing
│       ├── platform.ts         # Mobile detection
│       └── logger.ts           # Debug logging
├── dist/                       # Built output (tsup)
├── example/                    # Vite test dApp (also hosted at zondscan.com/dapp-example)
│   ├── index.html
│   ├── main.js
│   └── vite.config.js
├── docs/
│   └── JSON-RPC-REFERENCE.md   # All supported QRL RPC methods with examples
├── test-e2e.mjs                 # Headless E2E transport test
├── package.json
└── tsconfig.json
```

## Supported RPC Methods

**Restricted** (require wallet approval): `qrl_requestAccounts`, `qrl_sendTransaction`, `qrl_signTransaction`, `qrl_signMessage`, `qrl_signTypedData`, `wallet_addQrlChain`, `wallet_switchQrlChain`. The PQ-native `qrl_signMessage` (opaque bytes) and `qrl_signTypedData` (EIP-712-shaped) replaced the Ethereum-flavored set in v3.0.0; see docs/JSON-RPC-REFERENCE.md.

**Unrestricted** (auto-proxied, no approval): `qrl_chainId`, `qrl_blockNumber`, `qrl_getBalance`, `qrl_call`, `qrl_estimateGas`, `qrl_gasPrice`, `qrl_getTransactionByHash`, `qrl_getTransactionReceipt`, and 25+ more — see `src/config.ts` for the full list.

Full request/response examples are documented in `docs/JSON-RPC-REFERENCE.md`.

## Session Behavior

- Sessions persist in `localStorage` with a 7-day TTL
- On reconnect, the SDK re-joins the relay channel and skips key exchange if keys are already stored
- The relay buffers up to 50 messages per channel for 5 minutes when one side disconnects
- After 5 failed reconnection attempts, the SDK emits a `connection_lost` event

## Post-Quantum Transport

The transport layer is built on NIST-standardized post-quantum primitives, aligning QRL Connect's channel security with the same PQ guarantees the QRL network provides at the consensus layer:

- **ML-KEM-768 (Kyber)** — FIPS 203 key encapsulation, via `@noble/post-quantum`
- **HKDF-SHA-256** — derives per-direction AEAD keys from the shared secret, bound to the full handshake transcript (`LABEL || cid || pk || ct`)
- **AES-256-GCM** — authenticated encryption of every JSON-RPC payload, via WebCrypto SubtleCrypto

Authentication of the channel relies exclusively on the AES-GCM tag. ML-KEM's FIPS 203 implicit rejection (returning a pseudo-random secret on tampered ciphertext) is deliberately NOT used as an authentication signal.

A future hardening step is adding **ML-DSA-87 (Dilithium)** signatures over the handshake transcript for explicit mutual authentication against active MITM. The QRL ecosystem already ships `@theqrl/mldsa87` for this.
