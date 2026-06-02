import type { PersistedSession } from './KeyExchange.js';

/** dApp metadata shown to user in approval UI */
export interface DAppMetadata {
  name: string;
  url: string;
  icon?: string;
}

/**
 * Stored session for reconnection.
 *
 * v2 persists the derived AES-256 session key (not the ML-KEM secret key) —
 * the ML-KEM keypair is ephemeral and zeroized after the handshake.
 * Re-pair (generate a new QR) to rotate the session key.
 */
export interface DAppSession {
  version: 2;
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
  params?: unknown[];
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timestamp: number;
}

/**
 * Key-exchange wire-message types.
 *
 * v2 note: only SYNACK (wallet→dApp) and ACK (dApp→wallet) are transmitted
 * over the relay. The SYN step is carried by the QR code itself — the dApp's
 * ML-KEM-768 encapsulation key is embedded in the URI, not sent on the wire.
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

/** EIP-1193 provider events */
export interface ProviderEvents {
  connect: (info: { chainId: string }) => void;
  disconnect: (error: { code: number; message: string }) => void;
  chainChanged: (chainId: string) => void;
  accountsChanged: (accounts: string[]) => void;
  message: (message: { type: string; data: unknown }) => void;
  statusChanged: (status: ConnectionStatus) => void;
}

/** JSON-RPC request */
export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number;
  method: string;
  params?: unknown[];
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
 * (per EIP-6963). Defaults work for most consumers — override only when
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
 * wallet always returns the public key explicitly. Stateless verifiers
 * (e.g. the SDK's `verifyMessage` / `verifyTypedData`) need every field.
 */
export interface QrlSignedResult {
  /** 0x-hex of the 4595-byte ML-DSA-87 signature. */
  signature: string;
  /** 0x-hex of the 2592-byte ML-DSA-87 public key. */
  publicKey: string;
  /** 41-char checksummed Q-address derived from `publicKey`. */
  signer: string;
  /** 0x-hex of the 64-byte SHAKE256 digest that was signed. */
  digest: string;
  /** Scheme tag: 'QRL-SIGN-MSG-v1' or 'QRL-SIGN-TYPED-v1'. */
  schemeVersion: string;
}

/**
 * Response from `qrl_signTypedData`. Echoes `domain` so a stateless
 * verifier doesn't need to be told the domain out-of-band.
 */
export interface QrlSignedTypedDataResult extends QrlSignedResult {
  domain: Record<string, unknown>;
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
  types: Record<string, ReadonlyArray<{ name: string; type: string }>>;
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
}
