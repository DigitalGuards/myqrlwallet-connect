# QRL JSON-RPC Reference

Complete request/response examples for every method supported by `@qrlwallet/connect`. Based on the [QRL Web3 Wallet dApp Example](https://github.com/cyyber/zond-web3-wallet-dapp-example).

All examples use the EIP-1193 `provider.request()` interface, which is the same whether you're using the browser extension or QRL Connect:

```typescript
// Browser extension (EIP-6963)
const result = await extensionProvider.request({ method, params });

// QRL Connect (mobile wallet via QR)
import { QRLConnect } from '@qrlwallet/connect';
const qrl = new QRLConnect({ dappMetadata: { name: 'My dApp', url: '...' } });
const result = await qrl.request({ method, params });
```

---

## Restricted Methods (require user approval)

These methods open an approval screen in the wallet. The user must explicitly approve or reject.

### qrl_requestAccounts

Connect the user's wallet to your dApp. This is usually the first call you make.

```typescript
const accounts = await provider.request({
  method: "qrl_requestAccounts",
  params: [],
});
// => ["Q208318ecd68f26726CE7C54b29CaBA94584969B6"]
```

### qrl_sendTransaction

Send QRL or interact with a contract. The wallet shows transaction details for approval.

```typescript
const txHash = await provider.request({
  method: "qrl_sendTransaction",
  params: [{
    from: "Q208318ecd68f26726CE7C54b29CaBA94584969B6",
    to: "Q20E7Bde67f00EA38ABb2aC57e1B0DD93f518446c",
    value: "0x2386F26FC10000",  // 0.01 QRL in wei
    gas: "0x5208",              // 21000 (optional, auto-estimated)
    data: "0x",                 // contract call data (optional)
  }],
});
// => "0x3e306b5a5a37532e1734503f7d2427a86f2c992fbe471f5be403b9f734e661c5"
```

### qrl_signMessage

Sign opaque bytes (off-chain auth challenges, ownership proofs, anything without internal structure). The wallet displays the message for approval, hashes it with SHAKE256, signs with ML-DSA-87, and returns a stateless-verifiable response object.

`params[0]` is the signer Q-address (must equal the connected account).
`params[1]` is the message as **strict 0x-hex bytes**. The SDK does not accept bare UTF-8 strings here; the dApp UTF-8-encodes before sending so the wallet receives a single canonical form.

```typescript
const result = await provider.request({
  method: "qrl_signMessage",
  params: [
    "Q208318ecd68f26726CE7C54b29CaBA94584969B6",
    "0x48656c6c6f2c20514f4c21",  // "Hello, QRL!" in 0x-hex
  ],
});
// => {
//   signature:     "0x...<4595-byte ML-DSA-87 signature>",
//   publicKey:     "0x...<2592-byte ML-DSA-87 public key>",
//   signer:        "Q208318ecd68f26726CE7C54b29CaBA94584969B6",
//   digest:        "0x...<64-byte SHAKE256 digest>",
//   schemeVersion: "QRL-SIGN-MSG-v1"
// }

// Verify locally (no relay round-trip):
import { verifyMessage } from "@qrlwallet/connect";
const ok = verifyMessage({
  signature: result.signature,
  publicKey: result.publicKey,
  messageBytes: "0x48656c6c6f2c20514f4c21",
});
```

Digest computation: `digest = SHAKE256("QRL-SIGN-MSG-v1" || messageBytes, 64)`.
Signing uses `ctx = utf8("QRL-SIGN-MSG-v1")` and FIPS 204 §3.4 randomized (hedged) mode.

### qrl_signTypedData

Sign EIP-712-shaped structured data. Same shape as Ethereum's `signTypedData_v4` (`types`/`primaryType`/`domain`/`message`), but with post-quantum primitives: SHAKE256 hashing, native Dilithium ctx, 64-byte digests throughout, and `QRLDomain` in place of `EIP712Domain`.

`QRLDomain` is wallet-reserved. Allowed fields (each with a fixed type):

| Field | Type | Required |
|-------|------|----------|
| `name` | `string` | yes |
| `version` | `string` | no |
| `chainId` | `uint256` | no |
| `verifyingContract` | `address` | no |
| `salt` | `bytes32` | no |

Any other field name, or a type mismatch on a reserved name, is rejected by the wallet before signing.

```typescript
const result = await provider.request({
  method: "qrl_signTypedData",
  params: [
    "Q208318ecd68f26726CE7C54b29CaBA94584969B6",
    {
      types: {
        QRLDomain: [{ name: "name", type: "string" }],
        LoginChallenge: [
          { name: "account",  type: "address" },
          { name: "nonce",    type: "bytes32" },
          { name: "issuedAt", type: "uint64"  },
        ],
      },
      primaryType: "LoginChallenge",
      domain: { name: "zondscan.com" },
      message: {
        account:  "Q208318ecd68f26726CE7C54b29CaBA94584969B6",
        nonce:    "0xababab...",   // exactly 32 bytes
        issuedAt: "1747699200",     // string or 0x-hex for uintN ≥ 64
      },
    },
  ],
});
// => {
//   signature, publicKey, signer, digest,
//   schemeVersion: "QRL-SIGN-TYPED-v1",
//   domain:        { name: "zondscan.com" }
// }

import { verifyTypedData } from "@qrlwallet/connect";
const ok = verifyTypedData({
  signature: result.signature,
  publicKey: result.publicKey,
  payload, // same payload the dApp sent
});
```

Digest pipeline:

```
SCHEME_TAG_TYPED = utf8("QRL-SIGN-TYPED-v1")
domainHash  = SHAKE256(typeHash("QRLDomain") || encodedFields(domain), 64)
messageHash = SHAKE256(typeHash(primaryType) || encodedFields(message), 64)
digest      = SHAKE256(SCHEME_TAG_TYPED || domainHash || messageHash, 64)
```

Type system mirrors EIP-712: `address`, `bool`, `string`, `bytes`, `uintN` / `intN` (N ∈ multiples of 8, 8 ≤ N ≤ 256), `bytesN` (1 ≤ N ≤ 32), arrays `T[]` and `T[N]`, struct references. `uint64` and wider must be passed as strings or 0x-hex; JS `number` literals above the safe-integer range are rejected.

### Removed in v3.0.0

The Ethereum-flavored signing methods are no longer supported. A dApp that still calls them via `@qrlwallet/connect@^3` will get a "method not supported" error before the relay round-trip:

- `personal_sign` → replaced by `qrl_signMessage`
- `qrl_sign` → replaced by `qrl_signMessage` (with `[signer, messageHex]` argument order)
- `qrl_signTypedData_v3` / `qrl_signTypedData_v4` → replaced by `qrl_signTypedData` (single canonical version, no `_v3`/`_v4`)

Old signatures produced before the upgrade cannot be reproduced and aren't verifiable by the new helpers.

### wallet_addQrlChain

Ask the user to add a new chain to their wallet.

```typescript
await provider.request({
  method: "wallet_addQrlChain",
  params: [{
    chainId: "0x44",
    chainName: "My Custom Chain",
    rpcUrls: ["https://rpc.mychain.com"],
    blockExplorerUrls: ["https://explorer.mychain.com"],
    nativeCurrency: { name: "QRL", symbol: "QRL", decimals: 18 },
  }],
});
// => null
```

### wallet_switchQrlChain

Ask the user to switch to a different chain.

```typescript
await provider.request({
  method: "wallet_switchQrlChain",
  params: [{ chainId: "0x7e7e" }],
});
// => null
```

---

## Unrestricted Methods (no approval needed)

These are read-only calls that return data without user interaction. They're proxied through the wallet's RPC connection.

### qrl_chainId

```typescript
const chainId = await provider.request({ method: "qrl_chainId", params: [] });
// => "0x7e7e"
```

### qrl_blockNumber

```typescript
const blockNumber = await provider.request({ method: "qrl_blockNumber", params: [] });
// => "0x3345"
```

### qrl_getBalance

```typescript
const balance = await provider.request({
  method: "qrl_getBalance",
  params: ["Q208318ecd68f26726CE7C54b29CaBA94584969B6", "latest"],
});
// => "0x6cfe56f3795885980005"
```

### qrl_gasPrice

```typescript
const gasPrice = await provider.request({ method: "qrl_gasPrice", params: [] });
// => "0x3b9aca07"
```

### qrl_estimateGas

```typescript
const gas = await provider.request({
  method: "qrl_estimateGas",
  params: [{
    from: "Q208318ecd68f26726CE7C54b29CaBA94584969B6",
    to: "Q20B714091cF2a62DADda2847803e3f1B9D2D3779",
    value: "0x7",
  }],
});
// => "0x5208"
```

### qrl_call

```typescript
const result = await provider.request({
  method: "qrl_call",
  params: [{ to: "Q20E7Bde67f00EA38ABb2aC57e1B0DD93f518446c", value: "0x7" }, "latest"],
});
// => "0x"
```

### qrl_getTransactionByHash

```typescript
const tx = await provider.request({
  method: "qrl_getTransactionByHash",
  params: ["0xa52be92809541220ee0aaaede6047d9a6c5d0cd96a517c854d944ee70a0ebb44"],
});
// => { blockHash: "0x510e...", blockNumber: "0x442", from: "Q205f...", ... }
```

### qrl_getTransactionReceipt

```typescript
const receipt = await provider.request({
  method: "qrl_getTransactionReceipt",
  params: ["0x504ce587a65bdbdb6414a0c6c16d86a04dd79bfcc4f2950eec9634b30ce5370f"],
});
// => { blockHash: "0xe721...", status: "0x1", gasUsed: "0x5208", ... }
```

### qrl_getTransactionCount

```typescript
const nonce = await provider.request({
  method: "qrl_getTransactionCount",
  params: ["Q20E7Bde67f00EA38ABb2aC57e1B0DD93f518446c", "latest"],
});
// => "0x1"
```

### qrl_getBlockByNumber

```typescript
const block = await provider.request({
  method: "qrl_getBlockByNumber",
  params: ["0x324c", false],  // false = don't include full tx objects
});
// => { number: "0x68b3", hash: "0xd5f1...", transactions: [...], ... }
```

### qrl_getBlockByHash

```typescript
const block = await provider.request({
  method: "qrl_getBlockByHash",
  params: ["0x7daca88be141b9c778aa2d55ae81eab7766e97a9b2549e975680a6f20dd46fde", false],
});
```

### qrl_getCode

```typescript
const code = await provider.request({
  method: "qrl_getCode",
  params: ["Q208318ecd68f26726CE7C54b29CaBA94584969B6", "latest"],
});
// => "0x60806040..."
```

### qrl_getStorageAt

```typescript
const storage = await provider.request({
  method: "qrl_getStorageAt",
  params: ["Q20D20b8026B8F02540246f58120ddAAf35AECD9B", "0x0", "latest"],
});
// => "0x0000000000000000000000000000000000000000000000000000000000000000"
```

### qrl_getLogs

```typescript
const logs = await provider.request({
  method: "qrl_getLogs",
  params: [{
    fromBlock: "0x1234AB",
    toBlock: "latest",
    address: "Q208318ecd68f26726CE7C54b29CaBA94584969B6",
    topics: [],
  }],
});
// => [{ logIndex: "0x0", blockNumber: "0x233", topics: [...], ... }]
```

### qrl_feeHistory

```typescript
const feeHistory = await provider.request({
  method: "qrl_feeHistory",
  params: ["0x3", "latest", [10, 50]],
});
// => { oldestBlock: "0x17185", baseFeePerGas: ["0x7", ...], gasUsedRatio: [...] }
```

### web3_clientVersion

```typescript
const version = await provider.request({ method: "web3_clientVersion", params: [] });
// => "Gqrl/v0.2.1-stable/linux-amd64/go1.22.12"
```

### qrl_syncing

```typescript
const syncing = await provider.request({ method: "qrl_syncing", params: [] });
// => false (or { startingBlock, currentBlock, highestBlock } if syncing)
```

### qrl_accounts

```typescript
const accounts = await provider.request({ method: "qrl_accounts", params: [] });
// => ["Q20B714091cF2a62DADda2847803e3f1B9D2D3779"]
```

### Full list of unrestricted methods

| Method | Description |
|--------|-------------|
| `qrl_accounts` | Connected accounts |
| `qrl_blockNumber` | Latest block number |
| `qrl_call` | Execute call without tx |
| `qrl_chainId` | Current chain ID |
| `qrl_estimateGas` | Estimate gas for tx |
| `qrl_feeHistory` | Fee history |
| `qrl_gasPrice` | Current gas price |
| `qrl_getBalance` | Account balance |
| `qrl_getBlockByHash` | Block by hash |
| `qrl_getBlockByNumber` | Block by number |
| `qrl_getBlockTransactionCountByHash` | Tx count in block (by hash) |
| `qrl_getBlockTransactionCountByNumber` | Tx count in block (by number) |
| `qrl_getCode` | Contract bytecode |
| `qrl_getFilterChanges` | Poll filter changes |
| `qrl_getFilterLogs` | Get filter logs |
| `qrl_getLogs` | Get logs by filter |
| `qrl_getProof` | Merkle proof |
| `qrl_getStorageAt` | Storage at position |
| `qrl_getTransactionByBlockHashAndIndex` | Tx by block hash + index |
| `qrl_getTransactionByBlockNumberAndIndex` | Tx by block number + index |
| `qrl_getTransactionByHash` | Tx by hash |
| `qrl_getTransactionCount` | Account nonce |
| `qrl_getTransactionReceipt` | Tx receipt |
| `qrl_newBlockFilter` | Create block filter |
| `qrl_newFilter` | Create log filter |
| `qrl_newPendingTransactionFilter` | Create pending tx filter |
| `qrl_sendRawTransaction` | Send signed tx |
| `qrl_subscribe` | Subscribe to events |
| `qrl_syncing` | Sync status |
| `qrl_uninstallFilter` | Remove filter |
| `qrl_unsubscribe` | Unsubscribe |
| `web3_clientVersion` | Client version |
