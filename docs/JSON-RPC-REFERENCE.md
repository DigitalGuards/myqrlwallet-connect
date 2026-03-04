# Zond JSON-RPC Reference

Complete request/response examples for every method supported by `@qrlwallet/connect`. Based on the [Zond Web3 Wallet dApp Example](https://github.com/cyyber/zond-web3-wallet-dapp-example).

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

### zond_requestAccounts

Connect the user's wallet to your dApp. This is usually the first call you make.

```typescript
const accounts = await provider.request({
  method: "zond_requestAccounts",
  params: [],
});
// => ["Z208318ecd68f26726CE7C54b29CaBA94584969B6"]
```

### zond_sendTransaction

Send QRL or interact with a contract. The wallet shows transaction details for approval.

```typescript
const txHash = await provider.request({
  method: "zond_sendTransaction",
  params: [{
    from: "Z208318ecd68f26726CE7C54b29CaBA94584969B6",
    to: "Z20E7Bde67f00EA38ABb2aC57e1B0DD93f518446c",
    value: "0x2386F26FC10000",  // 0.01 QRL in wei
    gas: "0x5208",              // 21000 (optional, auto-estimated)
    data: "0x",                 // contract call data (optional)
  }],
});
// => "0x3e306b5a5a37532e1734503f7d2427a86f2c992fbe471f5be403b9f734e661c5"
```

### personal_sign

Sign a plain-text message. The wallet shows the message for approval and returns the signature + public key.

```typescript
const signedData = await provider.request({
  method: "personal_sign",
  params: [
    "0x506c65617365207369676e2074686973206d657373616765",  // hex-encoded UTF-8
    "Z208318ecd68f26726CE7C54b29CaBA94584969B6",
  ],
});
// => { signature: "0x0087c28d89...", publicKey: "0x04bfcabf8c..." }
```

### zond_signTypedData_v4

Sign structured data (EIP-712). The wallet renders the typed data in a readable format.

```typescript
const signedData = await provider.request({
  method: "zond_signTypedData_v4",
  params: [
    "Z208318ecd68f26726CE7C54b29CaBA94584969B6",
    {
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        Person: [
          { name: "name", type: "string" },
          { name: "wallet", type: "address" },
        ],
        Mail: [
          { name: "from", type: "Person" },
          { name: "to", type: "Person" },
          { name: "contents", type: "string" },
        ],
      },
      primaryType: "Mail",
      domain: {
        name: "Ether Mail",
        version: "1",
        chainId: 1,
        verifyingContract: "ZDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF",
      },
      message: {
        from: { name: "Alice", wallet: "ZCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826" },
        to: { name: "Bob", wallet: "ZbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB" },
        contents: "Hello, Bob!",
      },
    },
  ],
});
// => { signature: "0x0087c28d89...", publicKey: "0x04bfcabf8c..." }
```

### wallet_addZondChain

Ask the user to add a new chain to their wallet.

```typescript
await provider.request({
  method: "wallet_addZondChain",
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

### wallet_switchZondChain

Ask the user to switch to a different chain.

```typescript
await provider.request({
  method: "wallet_switchZondChain",
  params: [{ chainId: "0x7e7e" }],
});
// => null
```

---

## Unrestricted Methods (no approval needed)

These are read-only calls that return data without user interaction. They're proxied through the wallet's RPC connection.

### zond_chainId

```typescript
const chainId = await provider.request({ method: "zond_chainId", params: [] });
// => "0x7e7e"
```

### zond_blockNumber

```typescript
const blockNumber = await provider.request({ method: "zond_blockNumber", params: [] });
// => "0x3345"
```

### zond_getBalance

```typescript
const balance = await provider.request({
  method: "zond_getBalance",
  params: ["Z208318ecd68f26726CE7C54b29CaBA94584969B6", "latest"],
});
// => "0x6cfe56f3795885980005"
```

### zond_gasPrice

```typescript
const gasPrice = await provider.request({ method: "zond_gasPrice", params: [] });
// => "0x3b9aca07"
```

### zond_estimateGas

```typescript
const gas = await provider.request({
  method: "zond_estimateGas",
  params: [{
    from: "Z208318ecd68f26726CE7C54b29CaBA94584969B6",
    to: "Z20B714091cF2a62DADda2847803e3f1B9D2D3779",
    value: "0x7",
  }],
});
// => "0x5208"
```

### zond_call

```typescript
const result = await provider.request({
  method: "zond_call",
  params: [{ to: "Z20E7Bde67f00EA38ABb2aC57e1B0DD93f518446c", value: "0x7" }, "latest"],
});
// => "0x"
```

### zond_getTransactionByHash

```typescript
const tx = await provider.request({
  method: "zond_getTransactionByHash",
  params: ["0xa52be92809541220ee0aaaede6047d9a6c5d0cd96a517c854d944ee70a0ebb44"],
});
// => { blockHash: "0x510e...", blockNumber: "0x442", from: "Z205f...", ... }
```

### zond_getTransactionReceipt

```typescript
const receipt = await provider.request({
  method: "zond_getTransactionReceipt",
  params: ["0x504ce587a65bdbdb6414a0c6c16d86a04dd79bfcc4f2950eec9634b30ce5370f"],
});
// => { blockHash: "0xe721...", status: "0x1", gasUsed: "0x5208", ... }
```

### zond_getTransactionCount

```typescript
const nonce = await provider.request({
  method: "zond_getTransactionCount",
  params: ["Z20E7Bde67f00EA38ABb2aC57e1B0DD93f518446c", "latest"],
});
// => "0x1"
```

### zond_getBlockByNumber

```typescript
const block = await provider.request({
  method: "zond_getBlockByNumber",
  params: ["0x324c", false],  // false = don't include full tx objects
});
// => { number: "0x68b3", hash: "0xd5f1...", transactions: [...], ... }
```

### zond_getBlockByHash

```typescript
const block = await provider.request({
  method: "zond_getBlockByHash",
  params: ["0x7daca88be141b9c778aa2d55ae81eab7766e97a9b2549e975680a6f20dd46fde", false],
});
```

### zond_getCode

```typescript
const code = await provider.request({
  method: "zond_getCode",
  params: ["Z208318ecd68f26726CE7C54b29CaBA94584969B6", "latest"],
});
// => "0x60806040..."
```

### zond_getStorageAt

```typescript
const storage = await provider.request({
  method: "zond_getStorageAt",
  params: ["Z20D20b8026B8F02540246f58120ddAAf35AECD9B", "0x0", "latest"],
});
// => "0x0000000000000000000000000000000000000000000000000000000000000000"
```

### zond_getLogs

```typescript
const logs = await provider.request({
  method: "zond_getLogs",
  params: [{
    fromBlock: "0x1234AB",
    toBlock: "latest",
    address: "Z208318ecd68f26726CE7C54b29CaBA94584969B6",
    topics: [],
  }],
});
// => [{ logIndex: "0x0", blockNumber: "0x233", topics: [...], ... }]
```

### zond_feeHistory

```typescript
const feeHistory = await provider.request({
  method: "zond_feeHistory",
  params: ["0x3", "latest", [10, 50]],
});
// => { oldestBlock: "0x17185", baseFeePerGas: ["0x7", ...], gasUsedRatio: [...] }
```

### web3_clientVersion

```typescript
const version = await provider.request({ method: "web3_clientVersion", params: [] });
// => "Gzond/v0.2.1-stable-c50ef86d/linux-amd64/go1.22.12"
```

### zond_syncing

```typescript
const syncing = await provider.request({ method: "zond_syncing", params: [] });
// => false (or { startingBlock, currentBlock, highestBlock } if syncing)
```

### zond_accounts

```typescript
const accounts = await provider.request({ method: "zond_accounts", params: [] });
// => ["Z20B714091cF2a62DADda2847803e3f1B9D2D3779"]
```

### Full list of unrestricted methods

| Method | Description |
|--------|-------------|
| `zond_accounts` | Connected accounts |
| `zond_blockNumber` | Latest block number |
| `zond_call` | Execute call without tx |
| `zond_chainId` | Current chain ID |
| `zond_estimateGas` | Estimate gas for tx |
| `zond_feeHistory` | Fee history |
| `zond_gasPrice` | Current gas price |
| `zond_getBalance` | Account balance |
| `zond_getBlockByHash` | Block by hash |
| `zond_getBlockByNumber` | Block by number |
| `zond_getBlockTransactionCountByHash` | Tx count in block (by hash) |
| `zond_getBlockTransactionCountByNumber` | Tx count in block (by number) |
| `zond_getCode` | Contract bytecode |
| `zond_getFilterChanges` | Poll filter changes |
| `zond_getFilterLogs` | Get filter logs |
| `zond_getLogs` | Get logs by filter |
| `zond_getProof` | Merkle proof |
| `zond_getStorageAt` | Storage at position |
| `zond_getTransactionByBlockHashAndIndex` | Tx by block hash + index |
| `zond_getTransactionByBlockNumberAndIndex` | Tx by block number + index |
| `zond_getTransactionByHash` | Tx by hash |
| `zond_getTransactionCount` | Account nonce |
| `zond_getTransactionReceipt` | Tx receipt |
| `zond_newBlockFilter` | Create block filter |
| `zond_newFilter` | Create log filter |
| `zond_newPendingTransactionFilter` | Create pending tx filter |
| `zond_sendRawTransaction` | Send signed tx |
| `zond_subscribe` | Subscribe to events |
| `zond_syncing` | Sync status |
| `zond_uninstallFilter` | Remove filter |
| `zond_unsubscribe` | Unsubscribe |
| `web3_clientVersion` | Client version |
