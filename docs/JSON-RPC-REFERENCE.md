# QRL JSON-RPC Reference

Complete request/response examples for every method supported by `@qrlwallet/connect`. Based on the [QRL Web3 Wallet dApp Example](https://github.com/cyyber/zond-web3-wallet-dapp-example).

All examples use the EIP-1193 `provider.request()` interface, which is the same whether you're using the browser extension or QRL Connect:

```typescript
// Browser extension (EIP-6963)
const result = await extensionProvider.request({ method, params });

// QRL Connect (mobile wallet via QR)
import { QRLConnect } from '@qrlwallet/connect';
const qrl = new QRLConnect({
  dappMetadata: { name: 'My dApp', url: 'https://dapp.example' },
});
const result = await qrl.request({ method, params });
```

---

## Restricted Methods (require user approval)

These methods open an approval screen in the wallet. The user must explicitly approve or reject.

### qrl_requestAccounts

Connect the user's wallet to your dApp. This is usually the first call you make.

```typescript
const accounts = await provider.request({
  method: 'qrl_requestAccounts',
  params: [],
});
// => ["Q6aFB7dFC849bC16E439033DfEE7B296484619Db8fc7e3b7c20a1b1688B128259338aFfd79b7cdda8F28509607bc26eB67a4799Ae457Ec82b57A6a57dea04C194"]
```

The session has no authorized account before this call succeeds:
`qrl_accounts` returns `[]`, and every transaction or signing request fails
locally. The approval result contains exactly one current-format address.
Reuse that exact, case-sensitive string as each later `from` or `signer`.

### qrl_sendTransaction

Send QRL or interact with a contract. The wallet shows transaction details for approval.

```typescript
const txHash = await provider.request({
  method: 'qrl_sendTransaction',
  params: [
    {
      from: 'Q6aFB7dFC849bC16E439033DfEE7B296484619Db8fc7e3b7c20a1b1688B128259338aFfd79b7cdda8F28509607bc26eB67a4799Ae457Ec82b57A6a57dea04C194',
      to: 'Q22222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222',
      value: '0x2386F26FC10000', // 0.01 QRL in wei
      gas: '0x5208', // 21000 (optional, auto-estimated)
      data: '0x', // contract call data (optional)
    },
  ],
});
// => "0x3e306b5a5a37532e1734503f7d2427a86f2c992fbe471f5be403b9f734e661c5"
```

Transaction params must be exactly `[tx]`. The only accepted fields are
`from`, `to`, `value`, `gas`, `data`, and `chainId`; `from` and `to` are required.
Optional `chainId` is a positive canonical `0x` quantity with at most 64 hex
digits. It must match the connected wallet both when queued and immediately
before transport, including after a channel rejoin. The wallet independently
checks its live network at approval and signing.
`value` is a canonical `0x` quantity with at most 64 hex digits. `gas` is the
same, capped at `Number.MAX_SAFE_INTEGER`, or a non-negative safe integer.
`data` is even-length `0x` bytes capped at 128 KiB. Unknown fields, contract
creation, decimal strings, leading-zero quantities, and a `from` different
from the approved account are rejected.

### qrl_signTransaction

Validate and sign a transaction without broadcasting it. It uses the exact
same `[tx]` contract and account binding as `qrl_sendTransaction`.

### qrl_signMessage

Sign opaque bytes (off-chain auth challenges, ownership proofs, anything without internal structure). The wallet displays the message for approval, hashes it with SHAKE256, signs with ML-DSA-87, and returns a stateless-verifiable response object.

`params[0]` is the signer Q-address (must equal the connected account and use
the QIP-55 `Q` + 128 hex character format).
`params[1]` is the message as **strict 0x-hex bytes**, capped at 16 KiB. The SDK does not accept bare UTF-8 strings here; the dApp UTF-8-encodes before sending so the wallet receives a single canonical form.

Transport authentication establishes that the response came from the paired
session. It does not validate the returned ML-DSA signature or bind its public
key to the claimed signer. Treat `provider.request()` as `unknown`, validate
the exact method-specific shape, and perform bound verification with the
original challenge before using a result for authentication or authorization.

```typescript
import {
  hasSigningDescriptor,
  isQrlSignedMessageResult,
  verifyMessageForSigner,
} from '@qrlwallet/connect';

const signer =
  'Q6aFB7dFC849bC16E439033DfEE7B296484619Db8fc7e3b7c20a1b1688B128259338aFfd79b7cdda8F28509607bc26eB67a4799Ae457Ec82b57A6a57dea04C194';
const messageBytes = '0x48656c6c6f2c20514f4c21'; // "Hello, QRL!"
const rawResult = await provider.request({
  method: 'qrl_signMessage',
  params: [signer, messageBytes],
});
// => {
//   signature:     "0x...<4627-byte ML-DSA-87 signature>",
//   publicKey:     "0x...<2592-byte ML-DSA-87 public key>",
//   descriptor:    "0x010000", // exact 3-byte ML-DSA wallet descriptor
//   signer:        "Q6aFB7dFC...dea04C194",
//   digest:        "0x...<64-byte SHAKE256 digest>",
//   schemeVersion: "QRL-SIGN-MSG-v1"
// }

if (!isQrlSignedMessageResult(rawResult) || !hasSigningDescriptor(rawResult)) {
  throw new Error('Invalid or unbound qrl_signMessage response');
}
const ok = verifyMessageForSigner({
  expectedSigner: signer,
  descriptor: rawResult.descriptor,
  signature: rawResult.signature,
  publicKey: rawResult.publicKey,
  messageBytes,
});
if (!ok) throw new Error('qrl_signMessage verification failed');
```

Digest computation: `digest = SHAKE256("QRL-SIGN-MSG-v1" || messageBytes, 64)`.
Signing uses `ctx = utf8("QRL-SIGN-MSG-v1")` and FIPS 204 §3.4 randomized (hedged) mode.

### qrl_signTypedData

QIP-55 status: temporarily unavailable. The provider validates the signer and
account authorization, then rejects the request locally before relay use. The
historical `QRL-SIGN-TYPED-v1` preimage fixes an address at 20 bytes in one
32-byte word, so it cannot represent a 64-byte QIP-55 address.

```typescript
const signer =
  'Q6aFB7dFC849bC16E439033DfEE7B296484619Db8fc7e3b7c20a1b1688B128259338aFfd79b7cdda8F28509607bc26eB67a4799Ae457Ec82b57A6a57dea04C194';
const payload = {
  types: {
    QRLDomain: [{ name: 'name', type: 'string' }],
    LoginChallenge: [
      { name: 'account', type: 'address' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'issuedAt', type: 'uint64' },
    ],
  },
  primaryType: 'LoginChallenge',
  domain: { name: 'zondscan.com' },
  message: {
    account: signer,
    nonce: '0xababab...', // exactly 32 bytes
    issuedAt: '1747699200', // string or 0x-hex for uintN >= 64
  },
};

// Rejects locally: qrl_signTypedData is unavailable for QIP-55 until the
// 64-byte word encoding and signing scheme version are finalized.
await provider.request({ method: 'qrl_signTypedData', params: [signer, payload] });
```

The likely successor layout uses one 64-byte ABI word per typed value: native
addresses occupy all 64 bytes, while `uint256` and `int256` remain in the low
32 bytes. This layout still requires protocol ratification. The release must
assign a new scheme version and context tag, update the wallet and SDK in
lockstep, regenerate canonical fixtures, and decide how peers advertise the
capability. Reusing the v1 tag with a different preimage would make the signed
format ambiguous.

The exported v1 digest and verifier helpers remain available for address-free
payloads. They reject legacy Q + 40 addresses and unsupported QIP-55 address
fields consistently with the wallet. Provider typed-data requests stay disabled.

### Removed in v3.0.0

The Ethereum-flavored signing methods are no longer supported. A dApp that still calls them via `@qrlwallet/connect@^4` will get a "method not supported" error before the relay round-trip:

- `personal_sign` → replaced by `qrl_signMessage`
- `qrl_sign` → replaced by `qrl_signMessage` (with `[signer, messageHex]` argument order)
- `qrl_signTypedData_v3` / `qrl_signTypedData_v4` → reserved for replacement by a future versioned `qrl_signTypedData` format

Signatures from the removed Ethereum-flavored methods are outside the current helper contracts.

### Explicitly unsupported node mutation methods

`qrl_sendRawTransaction` and `wallet_addQrlChain` are unsupported. QRL Connect
does not act as a public transaction broadcaster or accept arbitrary node
configuration. Both are rejected locally along with unknown future signing
methods.

### wallet_switchQrlChain

Ask the user to switch to a different chain.

```typescript
await provider.request({
  method: 'wallet_switchQrlChain',
  params: [{ chainId: '0x7e7e' }],
});
// => null
```

The SDK verifies the wallet's reported chain state before resolving this call.
A success response while the wallet remains on the previous chain is rejected.

---

## Unrestricted Methods (no approval needed)

These explicitly allowlisted calls do not sign or broadcast transactions. They
are proxied through the wallet's hosted RPC boundary without user interaction.

### qrl_chainId

```typescript
const chainId = await provider.request({ method: 'qrl_chainId', params: [] });
// => "0x7e7e"
```

### qrl_blockNumber

```typescript
const blockNumber = await provider.request({ method: 'qrl_blockNumber', params: [] });
// => "0x3345"
```

### qrl_getBalance

```typescript
const balance = await provider.request({
  method: 'qrl_getBalance',
  params: [
    'Q6aFB7dFC849bC16E439033DfEE7B296484619Db8fc7e3b7c20a1b1688B128259338aFfd79b7cdda8F28509607bc26eB67a4799Ae457Ec82b57A6a57dea04C194',
    'latest',
  ],
});
// => "0x6cfe56f3795885980005"
```

### qrl_gasPrice

```typescript
const gasPrice = await provider.request({ method: 'qrl_gasPrice', params: [] });
// => "0x3b9aca07"
```

### qrl_estimateGas

```typescript
const gas = await provider.request({
  method: 'qrl_estimateGas',
  params: [
    {
      from: 'Q6aFB7dFC849bC16E439033DfEE7B296484619Db8fc7e3b7c20a1b1688B128259338aFfd79b7cdda8F28509607bc26eB67a4799Ae457Ec82b57A6a57dea04C194',
      to: 'Q22222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222',
      value: '0x7',
    },
  ],
});
// => "0x5208"
```

### qrl_call

```typescript
const result = await provider.request({
  method: 'qrl_call',
  params: [
    {
      to: 'Q22222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222',
      value: '0x7',
    },
    'latest',
  ],
});
// => "0x"
```

### qrl_getTransactionReceipt

```typescript
const receipt = await provider.request({
  method: 'qrl_getTransactionReceipt',
  params: ['0x504ce587a65bdbdb6414a0c6c16d86a04dd79bfcc4f2950eec9634b30ce5370f'],
});
// => { blockHash: "0xe721...", status: "0x1", gasUsed: "0x5208", ... }
```

### qrl_getTransactionCount

```typescript
const nonce = await provider.request({
  method: 'qrl_getTransactionCount',
  params: [
    'Q22222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222222',
    'latest',
  ],
});
// => "0x1"
```

### qrl_getBlockByNumber

```typescript
const block = await provider.request({
  method: 'qrl_getBlockByNumber',
  params: ['0x324c', false], // false = don't include full tx objects
});
// => { number: "0x68b3", hash: "0xd5f1...", transactions: [...], ... }
```

### qrl_getCode

```typescript
const code = await provider.request({
  method: 'qrl_getCode',
  params: [
    'Q6aFB7dFC849bC16E439033DfEE7B296484619Db8fc7e3b7c20a1b1688B128259338aFfd79b7cdda8F28509607bc26eB67a4799Ae457Ec82b57A6a57dea04C194',
    'latest',
  ],
});
// => "0x60806040..."
```

### qrl_getLogs

```typescript
const logs = await provider.request({
  method: 'qrl_getLogs',
  params: [
    {
      fromBlock: '0x1234AB',
      toBlock: 'latest',
      address:
        'Q6aFB7dFC849bC16E439033DfEE7B296484619Db8fc7e3b7c20a1b1688B128259338aFfd79b7cdda8F28509607bc26eB67a4799Ae457Ec82b57A6a57dea04C194',
      topics: [],
    },
  ],
});
// => [{ logIndex: "0x0", blockNumber: "0x233", topics: [...], ... }]
```

QIP-55 log topics are complete 64-byte VM words encoded as `0x` plus 128 hex characters. Event-signature and indexed dynamic-value hashes occupy the high 32 bytes followed by 32 zero bytes. Short 32-byte topic filters are rejected.

### qrl_accounts

```typescript
const accounts = await provider.request({ method: 'qrl_accounts', params: [] });
// => ["Q6aFB7dFC849bC16E439033DfEE7B296484619Db8fc7e3b7c20a1b1688B128259338aFfd79b7cdda8F28509607bc26eB67a4799Ae457Ec82b57A6a57dea04C194"]
```

This is a local authorization-cache read and never reaches hosted node RPC.
It returns `[]` before `qrl_requestAccounts` succeeds. It is not proof that the
dApp controls the address. Use a fresh `qrl_signMessage` challenge plus
`verifyMessageForSigner` for account authentication.

### Full list of unrestricted methods

| Method                      | Description             |
| --------------------------- | ----------------------- |
| `qrl_accounts`              | Connected accounts      |
| `qrl_blockNumber`           | Latest block number     |
| `qrl_call`                  | Execute call without tx |
| `qrl_chainId`               | Current chain ID        |
| `qrl_estimateGas`           | Estimate gas for tx     |
| `qrl_gasPrice`              | Current gas price       |
| `qrl_getBalance`            | Account balance         |
| `qrl_getBlockByNumber`      | Block by number         |
| `qrl_getCode`               | Contract bytecode       |
| `qrl_getLogs`               | Get logs by filter      |
| `qrl_getTransactionCount`   | Account nonce           |
| `qrl_getTransactionReceipt` | Tx receipt              |
| `net_version`               | Network version         |
| `net_listening`             | Node listening status   |
