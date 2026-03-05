/** dApp metadata shown to user in approval UI */
export interface DAppMetadata {
  name: string;
  url: string;
  icon?: string;
}

/** Stored session for reconnection */
export interface DAppSession {
  channelId: string;
  privateKey: string;
  otherPublicKey: string | null;
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

/** Key exchange message types */
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
  id: string; // channelId
  clientType: 'dapp' | 'wallet';
  message: string | object; // encrypted base64 string or plaintext object (for key exchange)
  seq?: number; // Monotonic sequence number for replay protection
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
}
