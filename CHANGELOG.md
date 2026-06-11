# Changelog

All notable changes to `@qrlwallet/connect` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.1.0] - 2026-06-11

Maturity hardening release: hardened TypeScript, a fenced crypto boundary, and
two protocol-adjacent robustness fixes. No wire-format changes; outputs are
byte-identical (parity vectors and KATs unchanged).

### Security

- **AEAD counter checkpointing (nonce-reuse fix)**: the session's
  `sendSeq`/`recvSeq` are now persisted before every encrypted send and after
  every successful decrypt. Previously counters were only persisted at the
  handshake and on `wallet_info`, so reloading a page mid-session could restore
  a stale `sendSeq` and reuse an AES-256-GCM nonce under the same key. Stored
  sessions bump to `version: 3`; v2 records are dropped (one-time forced
  re-pair) because their counters cannot be trusted.
- **Wire-input validation**: relay envelopes, SYNACK payloads, decrypted
  JSON-RPC responses, `wallet_info` payloads, and stored localStorage sessions
  are now validated with runtime guards instead of type assertions. Malformed
  input is dropped with a warning.
- **Request-id collision fix**: JSON-RPC request ids are now
  `<8-hex-random>-<counter>` strings. A bare counter restarts at 1 on page
  reload while the relay buffers messages for 5 minutes, so a stale buffered
  response could be delivered to a fresh request with the same small id.
- **All randomness through the CSPRNG boundary**: the `Math.random` UUID
  fallback is gone; channel ids and EIP-6963 uuids come from
  `crypto.getRandomValues` via `src/crypto/`.

### Added

- **Lost-ACK handshake recovery**: the dApp now answers a retransmitted
  SYNACK (sent by the wallet when its socket flapped before the original
  ACK arrived) with its cached ACK instead of ignoring it, so a transport
  drop mid-handshake converges instead of stalling half-open. Pairs with
  the wallet-side SYNACK retransmit (myqrlwallet-frontend PR #192).

### Changed

- **Crypto primitive boundary**: all cryptographic implementations (ML-KEM-768
  via `@noble/post-quantum`, SHAKE256 via `@noble/hashes`, ML-DSA-87 verify via
  `@theqrl/mldsa87`, AES-256-GCM / HKDF-SHA-256 / SHA-256 / CSPRNG via
  WebCrypto) are accessed exclusively through `src/crypto/primitives.ts`. An
  ESLint fence forbids crypto imports, `subtle`, `getRandomValues`,
  `randomUUID`, and `Math.random` everywhere else in `src/`.
- **Hardened TypeScript**: `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noImplicitOverride`, `noImplicitReturns`,
  `noFallthroughCasesInSwitch`, `noUnusedLocals/Parameters`, and
  `isolatedModules` are now on. ESLint runs the type-checked strict + stylistic
  presets with type assertions banned (`consistent-type-assertions: never`),
  `no-explicit-any`/`no-non-null-assertion` at error, and `ts-ignore` comments
  forbidden. Tests are linted with targeted relaxations.
- `DAppSession.version` is now `3` (see Security above).

### Removed

- `uuid` dependency (channel ids now come from the crypto boundary).

## [3.0.0] - 2026-06-03

Major release. Post-quantum signing surface, EIP-6963 wallet announcement, and a
connection-resilience overhaul. The signing change is breaking: all legacy
Ethereum signing methods are removed.

### Removed (BREAKING)

- Removed `personal_sign` and the previous `qrl_sign`. There is no EIP-191
  preamble, no Keccak256 message hashing, and no `EIP712Domain` typed data.
  dApps must migrate to `qrl_signMessage` / `qrl_signTypedData`.

### Added

- **Post-quantum signing methods**
  - `qrl_signMessage`: opaque message signing.
  - `qrl_signTypedData`: structured-data signing over QRL Structured Types with a
    `QRLDomain` separator (not `EIP712Domain`).
  - Digests use SHAKE256; signatures use ML-DSA-87 (Dilithium5) with a native
    `ctx` domain-separation tag.
  - Both return a rich result object (`QrlSignedResult` /
    `QrlSignedTypedDataResult`).
- **New `signing/` module exported from the package root**: `computeMessageDigest`,
  `computeTypedDataDigest`, `encodeType`, `typeHash`, `hashStruct`, `encodeField`,
  `verifyMessage`, `verifyTypedData`, byte helpers (`bytesToHex`, `hexToBytes`,
  `concatBytes`), and scheme constants (`SCHEME_VERSION_MSG`,
  `SCHEME_VERSION_TYPED`, `SCHEME_TAG_MSG`, `SCHEME_TAG_TYPED`, `DIGEST_LEN`).
- **New public types**: `QrlSignedResult`, `QrlSignedTypedDataResult`,
  `QrlSignMessageParams`, `QrlSignTypedDataParams`, `QrlTypedDataPayload`.
- **Cross-repo parity vectors** (`src/signing/__fixtures__/canonical.json`) run as
  part of `npm test` so SDK and wallet stay byte-compatible.
- **EIP-6963 provider announcement**: `QRLConnectProvider` announces itself
  (`QRL_CONNECT_PROVIDER_INFO`, `EIP6963ProviderInfoOverride`) so it coexists with
  the QRL browser extension in dApp wallet pickers.
- **Connection resilience**
  - Reconnect liveness probe (`RECONNECT_WALLET_PROBE_MS`, 12s): a dApp no longer
    claims "reconnecting" to a wallet that is gone; it terminates the session
    honestly instead.
  - Foreground/resume handling: re-arms on `visibilitychange` / `online` /
    `pageshow` (debounced) so a backgrounded dApp tab recovers.
  - Consumes relay channel roster + `terminated` state on auto-reconnect;
    `resume()` re-joins the channel after the probe tears it down.
  - `redirectUrl` in `DAppMetadata` for same-device peer-redirect
    (return-to-dApp after approval).

### Changed

- `SocketClient` join result now surfaces channel `participants` (counterparty
  roster) and a `terminated` flag.
- Example dApp reworked into an EIP-6963 wallet picker; signs a realistic
  QuantaPool `StakeIntent` typed-data payload; honest reconnect UX; peer-redirect
  demo.
- Expanded `docs/JSON-RPC-REFERENCE.md` to cover the new signing methods.

### Fixed

- `disconnect()` performs a full teardown (clears `pendingRestore`, `keyExchange`,
  and resume listeners) so no phantom reconnect can revive a dead channel.
- `clear keyExchange` on session terminate so `resume()` cannot revive a dead
  channel.
- Negative-hex `BigInt` crash and defensive input guards in the signing path.

### Security

- The signing surface is end-to-end post-quantum (ML-DSA-87 / SHAKE256). No
  classical-crypto fallback remains.

## [2.0.0] - 2026-04-22

### Changed

- PQP2 QR format: the public key is delivered via the relay rather than embedded
  in the QR (smaller, scannable codes).

### Added

- Connection watchdog and disconnect-correctness handling. (#9)

## [0.1.0] - 2026-03-04

- Initial published release of `@qrlwallet/connect`.
