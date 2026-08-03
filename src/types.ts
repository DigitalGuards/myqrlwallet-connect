import type { PersistedSession } from './KeyExchange.js';

/** dApp metadata shown to user in approval UI */
export interface DAppMetadata {
  name: string;
  url: string;
  icon?: string;
  /**
   * Optional credential-free HTTP(S) "return to dApp" target. HTTPS is
   * required except for explicit loopback development URLs. Sent to the
   * wallet in ORIGINATOR_INFO; after the wallet resolves a restricted request
   * it bounces the user back here so a same-device flow does not strand the
   * user in the wallet.
   */
  redirectUrl?: string;
}

/**
 * Stored session for reconnection.
 *
 * Persists the derived AES-256 session key (not the ML-KEM secret key);
 * the ML-KEM keypair is ephemeral and zeroized after the handshake.
 * Re-pair (generate a new QR) to rotate the session key.
 *
 * v5 checkpoints every seal/open, requires exclusive browser-tab ownership,
 * and proves the AEAD key came from a PQP3 capability-bound handshake.
 * Older records cannot prove all three invariants and are dropped.
 */
export interface DAppSession {
  version: 5;
  channelId: string;
  keyExchange: PersistedSession;
  dappMetadata: DAppMetadata;
  connectedAccounts: string[];
  chainId: string;
  createdAt: number;
  lastActivity: number;
}

/** Pending JSON-RPC request awaiting wallet response */
export interface PendingRequest {
  id: string | number;
  method: string;
  params?: unknown[] | undefined;
  /** Immutable postcondition captured before caller-owned params can change. */
  expectedChainId?: string | undefined;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timestamp: number;
}

/**
 * Key-exchange wire-message types.
 *
 * v3 note: only SYNACK (wallet to dApp) and ACK (dApp to wallet) are
 * transmitted over the relay. The SYN step is represented by the pairing URI,
 * while the relay carries only the dApp's ML-KEM public key. The URI contains
 * the key fingerprint and a capability that is never uploaded to the relay.
 */
export enum KeyExchangeMessageType {
  SYN = 'key_handshake_SYN',
  SYNACK = 'key_handshake_SYNACK',
  ACK = 'key_handshake_ACK',
}

/** Message types for the relay protocol */
export enum MessageType {
  KEY_EXCHANGE = 'key_exchange',
  JSONRPC = 'jsonrpc',
  WALLET_INFO = 'wallet_info',
  ORIGINATOR_INFO = 'originator_info',
  TERMINATE = 'terminate',
  PING = 'ping',
  READY = 'ready',
}

/** Wire message format sent through the relay */
export interface RelayMessage {
  id: string;
  clientType: 'dapp' | 'wallet';
  message: string | object;
  seq?: number;
}

/** Connection state */
export enum ConnectionStatus {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  WAITING = 'waiting',
  KEY_EXCHANGE = 'key_exchange',
  CONNECTED = 'connected',
  RECONNECTING = 'reconnecting',
}

/**
 * A response for a request issued by a PREVIOUS page load. Same-device
 * approvals bounce back via a URL open, which reloads the dApp page and
 * destroys the awaiting promise; the SDK persists in-flight restricted
 * request ids and surfaces their eventual responses through this event.
 */
export interface LateResponse {
  id: string | number;
  method: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** EIP-1193 provider events */
export interface ProviderEvents {
  connect: (info: { chainId: string }) => void;
  disconnect: (error: { code: number; message: string }) => void;
  chainChanged: (chainId: string) => void;
  accountsChanged: (accounts: string[]) => void;
  message: (message: { type: string; data: unknown }) => void;
  statusChanged: (status: ConnectionStatus) => void;
  late_response: (payload: LateResponse) => void;
}

/** JSON-RPC request */
export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number;
  method: string;
  params?: unknown[] | undefined;
}

/** JSON-RPC response */
export interface JsonRpcResponse {
  jsonrpc: string;
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * EIP-6963 wallet identity advertised to dApps.
 *
 * `rdns` MUST be unique to this wallet and SHOULD be a reverse-DNS string
 * (per EIP-6963). Defaults work for most consumers - override only when
 * embedding the SDK inside a different branded wallet.
 */
export interface EIP6963ProviderInfoOverride {
  name?: string;
  icon?: string;
  rdns?: string;
}

/**
 * Rich response object returned by both `qrl_signMessage` and
 * `qrl_signTypedData`. The signature alone is not enough to verify since
 * ML-DSA-87 public keys cannot be recovered from a signature, so the
 * wallet always returns the public key explicitly. Stateless verifiers need
 * the original payload plus the signature fields below.
 */
export interface QrlSignedResult {
  /** 0x-hex of the 4627-byte ML-DSA-87 signature. */
  signature: string;
  /** 0x-hex of the 2592-byte ML-DSA-87 public key. */
  publicKey: string;
  /**
   * 0x-hex of the 3-byte wallet descriptor used to derive `signer`.
   * Optional while older wallet builds are upgraded; bound verification
   * requires it.
   */
  descriptor?: string;
  /** Current 41-character checksummed Q-address derived from descriptor + key. */
  signer: string;
  /** 0x-hex of the 64-byte SHAKE256 digest that was signed. */
  digest: string;
  /** Scheme tag: 'QRL-SIGN-MSG-v1' or 'QRL-SIGN-TYPED-v1'. */
  schemeVersion: QrlSigningSchemeVersion;
}

/** A current wallet response whose descriptor can be signer-bound. */
export interface QrlSignedResultWithDescriptor extends QrlSignedResult {
  descriptor: string;
}

export type QrlSigningSchemeVersion = 'QRL-SIGN-MSG-v1' | 'QRL-SIGN-TYPED-v1';

/** Strict wire shape returned by `qrl_signMessage`. */
export interface QrlSignedMessageResult extends QrlSignedResult {
  schemeVersion: 'QRL-SIGN-MSG-v1';
}

/**
 * Response from `qrl_signTypedData`. Echoes `domain` so a stateless
 * verifier doesn't need to be told the domain out-of-band.
 */
export interface QrlSignedTypedDataResult extends QrlSignedResult {
  schemeVersion: 'QRL-SIGN-TYPED-v1';
  domain: Record<string, unknown>;
}

/** Every strict signing-result wire shape understood by this SDK. */
export type QrlSigningResult = QrlSignedMessageResult | QrlSignedTypedDataResult;

const SIGNATURE_HEX_BYTES = 4627;
const PUBLIC_KEY_HEX_BYTES = 2592;
const DIGEST_HEX_BYTES = 64;
const MESSAGE_RESULT_KEYS: readonly string[] = [
  'signature',
  'publicKey',
  'signer',
  'digest',
  'schemeVersion',
];
const MESSAGE_RESULT_KEYS_WITH_DESCRIPTOR: readonly string[] = [
  ...MESSAGE_RESULT_KEYS,
  'descriptor',
];
const TYPED_RESULT_KEYS: readonly string[] = [...MESSAGE_RESULT_KEYS, 'domain'];
const TYPED_RESULT_KEYS_WITH_DESCRIPTOR: readonly string[] = [...TYPED_RESULT_KEYS, 'descriptor'];

function isSigningResultRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function hasExactOwnKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(record);
  return (
    keys.length === expected.length &&
    keys.every((key) => typeof key === 'string' && expected.includes(key))
  );
}

function isFixedHex(value: unknown, bytes: number): value is string {
  return (
    typeof value === 'string' && value.length === bytes * 2 + 2 && /^0x[0-9a-fA-F]+$/.test(value)
  );
}

function isSigningDescriptor(value: unknown): value is string {
  return typeof value === 'string' && /^0x01[0-9a-fA-F]{4}$/.test(value);
}

function hasValidSigningFields(record: Record<string, unknown>): boolean {
  return (
    isFixedHex(record.signature, SIGNATURE_HEX_BYTES) &&
    isFixedHex(record.publicKey, PUBLIC_KEY_HEX_BYTES) &&
    (!hasOwn(record, 'descriptor') || isSigningDescriptor(record.descriptor)) &&
    typeof record.signer === 'string' &&
    /^Q[0-9a-fA-F]{40}$/.test(record.signer) &&
    isFixedHex(record.digest, DIGEST_HEX_BYTES)
  );
}

/**
 * Validate an unknown value as the exact `qrl_signMessage` result wire shape.
 * This checks structure and fixed widths only. Use `verifyMessageForSigner`
 * with the original message to authenticate the signature and signer binding.
 */
export function isQrlSignedMessageResult(value: unknown): value is QrlSignedMessageResult {
  try {
    if (!isSigningResultRecord(value)) return false;
    const keys = hasOwn(value, 'descriptor')
      ? MESSAGE_RESULT_KEYS_WITH_DESCRIPTOR
      : MESSAGE_RESULT_KEYS;
    return (
      hasExactOwnKeys(value, keys) &&
      value.schemeVersion === 'QRL-SIGN-MSG-v1' &&
      hasValidSigningFields(value)
    );
  } catch {
    return false;
  }
}

/**
 * Validate an unknown value as the exact `qrl_signTypedData` result wire shape.
 * This checks structure and fixed widths only. Use `verifyTypedDataForSigner`
 * with the original payload to authenticate the signature and signer binding.
 */
export function isQrlSignedTypedDataResult(value: unknown): value is QrlSignedTypedDataResult {
  try {
    if (!isSigningResultRecord(value)) return false;
    const keys = hasOwn(value, 'descriptor')
      ? TYPED_RESULT_KEYS_WITH_DESCRIPTOR
      : TYPED_RESULT_KEYS;
    return (
      hasExactOwnKeys(value, keys) &&
      value.schemeVersion === 'QRL-SIGN-TYPED-v1' &&
      isSigningResultRecord(value.domain) &&
      hasValidSigningFields(value)
    );
  } catch {
    return false;
  }
}

/** Validate either exact signing-result wire shape from an unknown value. */
export function isQrlSignedResult(value: unknown): value is QrlSigningResult {
  return isQrlSignedMessageResult(value) || isQrlSignedTypedDataResult(value);
}

/**
 * Strictly validate an unknown signing result and narrow it to one carrying
 * the exact 3-byte ML-DSA descriptor required for signer-bound verification.
 */
export function hasSigningDescriptor(
  result: unknown
): result is QrlSigningResult & QrlSignedResultWithDescriptor {
  try {
    return (
      isQrlSignedResult(result) &&
      hasOwn(result, 'descriptor') &&
      isSigningDescriptor(result.descriptor)
    );
  } catch {
    return false;
  }
}

/**
 * `qrl_signMessage` params: `[signer, messageHex]`. `signer` must equal the
 * dApp's currently-connected account; the wallet rejects mismatches before
 * unlocking. `messageHex` is strict `0x`-prefixed bytes (no UTF-8 strings).
 */
export type QrlSignMessageParams = [string, string];

/**
 * `qrl_signTypedData` params: `[signer, payload]`. Payload mirrors EIP-712
 * shape: `{ types, primaryType, domain, message }`, but with `QRLDomain`
 * in place of `EIP712Domain` and SHAKE256-based hashing. See `signing/`
 * for the full encoder.
 */
export interface QrlTypedDataPayload {
  types: Record<string, readonly { name: string; type: string }[]>;
  primaryType: string;
  domain: Record<string, unknown>;
  message: Record<string, unknown>;
}
export type QrlSignTypedDataParams = [string, QrlTypedDataPayload];

/** QRL Connect configuration */
export interface QRLConnectOptions {
  dappMetadata: DAppMetadata;
  relayUrl?: string;
  chainId?: string;
  /** Auto-reconnect to stored session on init */
  autoReconnect?: boolean;
  /** Session storage key prefix */
  storageKey?: string;
  /** Enable debug logging */
  debug?: boolean;
  /**
   * Announce the provider via EIP-6963 so dApp wallet pickers can see it
   * alongside the QRL browser extension. Defaults to true in browser
   * environments. Set false to suppress (e.g. when the dApp wires the
   * provider in manually).
   */
  announceProvider?: boolean;
  /** Override the EIP-6963 announce metadata (name / icon / rdns). */
  providerInfo?: EIP6963ProviderInfoOverride;
  /**
   * On mobile browsers, deep-link (`qrlconnect://resume`) to foreground the
   * wallet app when a restricted request is made while the wallet is absent
   * from the relay channel. A backgrounded wallet app loses its socket
   * within seconds; the relay buffers the request, and without the redirect
   * it would sit there until the user remembers to switch apps on their
   * own. Defaults to true. Set false when the dApp runs its own
   * "open wallet" UX.
   */
  walletRedirectOnRequest?: boolean;
}
