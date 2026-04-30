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
