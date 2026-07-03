# Test dApp: QRL Connect example

A minimal Vite dApp for exercising the full QRL Connect flow end-to-end. Also the source of the hosted example served by ZondScan at [`/dapp-example`](https://zondscan.com/dapp-example).

## What QRL Connect is

`@qrlwallet/connect` is a self-hosted, end-to-end encrypted protocol that lets any QRL dApp pair with the MyQRLWallet mobile and desktop apps; similar in spirit to WalletConnect, but built specifically for the Quantum Resistant Ledger so it can handle Q-addresses and migrate to post-quantum cryptography on our own timeline.

```
┌─────────────────────┐                        ┌──────────────────────────┐
│  External dApp      │                        │  MyQRLWallet App         │
│                     │                        │  ┌──────────────────┐    │
│  @qrlwallet/connect │                        │  │ Native: QR scan  │    │
│  - QR / deep link   │                        │  │ + deep links     │    │
│  - EIP-1193 provider│                        │  └────────┬─────────┘    │
└──────────┬──────────┘                        │           │ bridge       │
           │                                   │  ┌────────▼─────────┐    │
           │ Socket.IO                         │  │ WebView: Socket  │    │
           │ (E2E encrypted ciphertext)        │  │ client, ML-KEM,  │    │
           ▼                                   │  │ signing, approval│    │
      ┌─────────────┐    Socket.IO             │  │ UI, sessions     │    │
      │ Relay Server│<===========================│                  │    │
      │(qrlwallet.  │                          │  └──────────────────┘    │
      │   com)      │                          │                          │
      └─────────────┘                          └──────────────────────────┘
```

- **SDK (`@qrlwallet/connect`)**: the npm package your dApp installs. Generates `qrlconnect://` URIs, runs the ML-KEM-768 handshake, and exposes an EIP-1193 `provider.request()` interface so your dApp talks to it like a browser-extension wallet.
- **Relay**: a stateless Socket.IO message router in `myqrlwallet-backend/src/relay/`. Sees only ciphertext; buffers up to 50 messages for 5 min when the phone is backgrounded.
- **Wallet**: signing, encryption, and approval UI all live inside the MyQRLWallet web app, reused by both the React Native WebView (mobile) and the Electron renderer (desktop); the native layers only do QR scanning / `qrlconnect://` deep-link handling.

Full architectural details, RPC method list, and session/reconnect behavior live in the [repo CLAUDE.md](../CLAUDE.md) and [main README](../README.md). Per-method request/response examples are in [`docs/JSON-RPC-REFERENCE.md`](../docs/JSON-RPC-REFERENCE.md).

## What this example does

- Generates a connection URI and renders it as a scannable QR code
- Connects to a wallet via the relay and walks through the 3-step SYN/SYNACK/ACK handshake
- Lets you call `qrl_sendTransaction`, `qrl_signMessage`, `qrl_signTypedData`, and a selection of read-only RPC methods
- Streams every inbound/outbound event to an on-page log so you can see the protocol in action

The relay URL is hardcoded to `https://qrlwallet.com` (production) via the `RELAY_URL` constant at the top of `main.js`. For local development against a backend on `http://localhost:3000`, edit that constant before running `npm run dev`.

## Running it locally

```bash
# 1. Start the backend relay (from myqrlwallet-backend/)
cd ../../myqrlwallet-backend
npm run dev

# 2. Start the test dApp (from this directory)
cd ../qrlwallet-connect/example
npm install
npm run dev
```

Opens at http://localhost:5174.

## Production build (for hosted deployments)

```bash
npm install
npm run build
# Output in dist/
```

ZondScan's `ExplorerFrontend` has a `prebuild` script that clones this repo, runs the build with `--base=/dapp-example/`, and copies `dist/` into its `public/dapp-example/` so the SPA is served at `https://zondscan.com/dapp-example`. See [`scripts/README.md`](https://github.com/DigitalGuards/zondscan/tree/dev/ExplorerFrontend/scripts) in that repo for details.

## Testing with the mobile app

1. Pick **MyQRLWallet** in the test dApp's wallet picker to generate a QR code
2. Open MyQRLWallet app on your phone
3. Tap the QR scan button and scan the code
4. The wallet should connect: you'll see the account address appear
5. Try **Send Transaction**, **Sign Message**, and the **Read-only RPC** calls
6. Check the event log at the bottom for the full message flow

## Testing with the desktop app

On a desktop browser the QR is joined by two actions aimed at the MyQRLWallet desktop wallet (Electron):

1. **Open in MyQRLWallet**: a `qrlconnect://` link. The installed desktop wallet registers the scheme with the OS (HKCU on Windows via NSIS, `CFBundleURLTypes` on macOS, `x-scheme-handler` on Linux), so clicking it launches or foregrounds the wallet, which stages the URI behind an explicit consent modal before any relay contact.
2. **Copy connection code**: copies the raw URI for the wallet's paste fallback (Settings > dApp Sessions > Connect a dApp). Use this when the protocol handler isn't registered, or when the dApp runs on a different machine than the wallet.

The QR itself stays useful on desktop too: it's how a phone pairs with a dApp shown on a monitor.

## Testing deep links (mobile browser)

If you open this test dApp in a mobile browser, the SDK will detect it. You can copy the `qrlconnect://` URI from the URI display box and open it manually to test the deep link flow.
