export { QRLConnectProvider, QRL_CONNECT_PROVIDER_INFO } from './QRLConnectProvider.js';
export { ConnectionManager } from './ConnectionManager.js';
export { KeyExchange } from './KeyExchange.js';
export { SocketClient } from './SocketClient.js';

export {
  type DAppMetadata,
  type DAppSession,
  type PendingRequest,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type QRLConnectOptions,
  type EIP6963ProviderInfoOverride,
  type ProviderEvents,
  type RelayMessage,
  ConnectionStatus,
  KeyExchangeMessageType,
  MessageType,
} from './types.js';

export {
  type PersistedSession,
  type Session,
  type AckMessage,
  type SynAckMessage,
} from './KeyExchange.js';

export {
  generateConnectionURI,
  parseConnectionURI,
  cidToString,
  cidFromString,
  cidRandom,
  computeFingerprint,
  fingerprintEquals,
  BLOB_LEN,
  CID_LEN,
  FP_LEN,
  type ParsedURI,
} from './utils/qrUri.js';
export { isMobileBrowser, getAppStoreUrl } from './utils/platform.js';
export {
  RESTRICTED_METHODS,
  UNRESTRICTED_METHODS,
  DEFAULT_RELAY_URL,
  PROTOCOL_VERSION,
} from './config.js';

// Convenience alias
export { QRLConnectProvider as QRLConnect } from './QRLConnectProvider.js';
