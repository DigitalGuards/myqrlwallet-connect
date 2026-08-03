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
// => ["Q208318ecd68f26726CE7C54b29CaBA94584969B6"]
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
      from: 'Q208318ecd68f26726CE7C54b29CaBA94584969B6',
      to: 'Q20E7Bde67f00EA38ABb2aC57e1B0DD93f518446c',
      value: '0x2386F26FC10000', // 0.01 QRL in wei
      gas: '0x5208', // 21000 (optional, auto-estimated)
      data: '0x', // contract call data (optional)
    },
  ],
});
// => "0x3e306b5a5a37532e1734503f7d2427a86f2c992fbe471f5be403b9f734e661c5"
```

Transaction params must be exactly `[tx]`. The only accepted fields are
`from`, `to`, `value`, `gas`, and `data`; `from` and `to` are required.
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
the current `Q` + 40 hex character format).
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

const signer = 'Q208318ecd68f26726CE7C54b29CaBA94584969B6';
const messageBytes = '0x48656c6c6f2c20514f4c21'; // "Hello, QRL!"
const rawResult = await provider.request({
  method: 'qrl_signMessage',
  params: [signer, messageBytes],
});
// => {
//   signature:     "0x...<4627-byte ML-DSA-87 signature>",
//   publicKey:     "0x...<2592-byte ML-DSA-87 public key>",
//   descriptor:    "0x010000", // exact 3-byte ML-DSA wallet descriptor
//   signer:        "Q208318ecd68f26726CE7C54b29CaBA94584969B6",
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

Sign EIP-712-shaped structured data. Same shape as Ethereum's `signTypedData_v4` (`types`/`primaryType`/`domain`/`message`), but with post-quantum primitives: SHAKE256 hashing, native Dilithium ctx, 64-byte digests throughout, and `QRLDomain` in place of `EIP712Domain`.

`QRLDomain` is wallet-reserved. Allowed fields (each with a fixed type):

| Field               | Type      | Required |
| ------------------- | --------- | -------- |
| `name`              | `string`  | yes      |
| `version`           | `string`  | no       |
| `chainId`           | `uint256` | no       |
| `verifyingContract` | `address` | no       |
| `salt`              | `bytes32` | no       |

Any other field name, or a type mismatch on a reserved name, is rejected by the wallet before signing.

```typescript
import {
  hasSigningDescriptor,
  isQrlSignedTypedDataResult,
  verifyTypedDataForSigner,
} from '@qrlwallet/connect';

const signer = 'Q208318ecd68f26726CE7C54b29CaBA94584969B6';
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
const rawResult = await provider.request({
  method: 'qrl_signTypedData',
  params: [signer, payload],
});
// => {
//   signature, publicKey, descriptor, signer, digest,
//   schemeVersion: "QRL-SIGN-TYPED-v1",
//   domain:        { name: "zondscan.com" }
// }

if (!isQrlSignedTypedDataResult(rawResult) || !hasSigningDescriptor(rawResult)) {
  throw new Error('Invalid or unbound qrl_signTypedData response');
}
const ok = verifyTypedDataForSigner({
  expectedSigner: signer,
  descriptor: rawResult.descriptor,
  signature: rawResult.signature,
  publicKey: rawResult.publicKey,
  payload,
});
if (!ok) throw new Error('qrl_signTypedData verification failed');
```

The lower-level `verifyMessageSignature` and `verifyTypedDataSignature`
helpers verify a signature against the public key supplied by the caller. They
do not bind that key to `result.signer`, so they are not sufficient on their
own for account authentication or authorization. The old `verifyMessage` and
`verifyTypedData` names remain as deprecated aliases. Bound verification
returns `false` when an older wallet response omits `descriptor`; request a
new signature after the wallet is upgraded. The strict shape guards validate
field sets, fixed widths, the current Q + 40 signer shape, and method-specific
scheme tags. They perform no cryptographic verification.

Digest pipeline:

```
SCHEME_TAG_TYPED = utf8("QRL-SIGN-TYPED-v1")
domainHash  = SHAKE256(typeHash("QRLDomain") || encodedFields(domain), 64)
messageHash = SHAKE256(typeHash(primaryType) || encodedFields(message), 64)
digest      = SHAKE256(SCHEME_TAG_TYPED || domainHash || messageHash, 64)
```

Type system mirrors EIP-712: `address`, `bool`, `string`, `bytes`, `uintN` / `intN` (N ∈ multiples of 8, 8 ≤ N ≤ 256), `bytesN` (1 ≤ N ≤ 32), arrays `T[]` and `T[N]`, struct references. `uint64` and wider must be passed as strings or 0x-hex; JS `number` literals above the safe-integer range are rejected.

The SDK applies deterministic resource limits before forwarding typed data:
32 struct types, 32 fields per struct, 256 total fields, 12 levels each for
type graphs and array types, 256 items per array, 2,048 encoded values, and
16 KiB per dynamic string or bytes field. Identifier names are canonical and
prototype-sensitive names are rejected.

### Removed in v3.0.0

The Ethereum-flavored signing methods are no longer supported. A dApp that still calls them via `@qrlwallet/connect@^4` will get a "method not supported" error before the relay round-trip:

- `personal_sign` → replaced by `qrl_signMessage`
- `qrl_sign` → replaced by `qrl_signMessage` (with `[signer, messageHex]` argument order)
- `qrl_signTypedData_v3` / `qrl_signTypedData_v4` → replaced by `qrl_signTypedData` (single canonical version, no `_v3`/`_v4`)

Old signatures produced before the upgrade cannot be reproduced and aren't verifiable by the new helpers.

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
  params: ['Q208318ecd68f26726CE7C54b29CaBA94584969B6', 'latest'],
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
      from: 'Q208318ecd68f26726CE7C54b29CaBA94584969B6',
      to: 'Q20B714091cF2a62DADda2847803e3f1B9D2D3779',
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
  params: [{ to: 'Q20E7Bde67f00EA38ABb2aC57e1B0DD93f518446c', value: '0x7' }, 'latest'],
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
  params: ['Q20E7Bde67f00EA38ABb2aC57e1B0DD93f518446c', 'latest'],
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
  params: ['Q208318ecd68f26726CE7C54b29CaBA94584969B6', 'latest'],
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
      address: 'Q208318ecd68f26726CE7C54b29CaBA94584969B6',
      topics: [],
    },
  ],
});
// => [{ logIndex: "0x0", blockNumber: "0x233", topics: [...], ... }]
```

### qrl_accounts

```typescript
const accounts = await provider.request({ method: 'qrl_accounts', params: [] });
// => ["Q20B714091cF2a62DADda2847803e3f1B9D2D3779"]
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
