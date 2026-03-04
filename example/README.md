# Test dApp

A minimal dApp for testing the full QRL Connect flow end-to-end.

## What it does

- Generates a QR code using the SDK
- Connects to a wallet when you scan it with the QRL Wallet app
- Lets you send a transaction, sign a message, or call read-only RPC methods
- Logs every event so you can see exactly what's happening

## Running it

```bash
# 1. Start the backend relay (from myqrlwallet-backend/)
cd ../../../myqrlwallet-backend
npm run dev

# 2. Start the test dApp (from this directory)
cd ../qrlwallet-connect/example
npm install
npm run dev
```

Opens at http://localhost:5174. The dApp auto-detects `localhost` and points at `http://localhost:3000` for the relay.

## Testing with the mobile app

1. Click **Generate QR Code** in the test dApp
2. Open MyQRLWallet app on your phone
3. Tap the QR scan button and scan the code
4. The wallet should connect — you'll see the account address appear
5. Try **Send Transaction**, **Sign Message**, and the **Read-only RPC** calls
6. Check the event log at the bottom for the full message flow

## Testing deep links (mobile browser)

If you open this test dApp in a mobile browser, the SDK will detect it. You can copy the `qrlconnect://` URI from the URI display box and open it manually to test the deep link flow.
