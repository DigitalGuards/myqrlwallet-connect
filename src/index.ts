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
  type QrlSignedResult,
  type QrlSignedTypedDataResult,
  type QrlSignMessageParams,
  type QrlSignTypedDataParams,
  type QrlTypedDataPayload,
  ConnectionStatus,
  KeyExchangeMessageType,
  MessageType,
} from './types.js';

export {
  computeMessageDigest,
  computeTypedDataDigest,
  encodeType,
  typeHash,
  hashStruct,
  encodeField,
  verifyMessage,
  verifyTypedData,
  bytesToHex,
  hexToBytes,
  concatBytes,
  SCHEME_VERSION_MSG,
  SCHEME_VERSION_TYPED,
  SCHEME_TAG_MSG,
  SCHEME_TAG_TYPED,
  DIGEST_LEN,
  type TypedDataPayload,
  type TypeMap,
  type StructDef,
  type TypedField,
  type Domain,
  type Message,
  type VerifyMessageParams,
  type VerifyTypedDataParams,
} from './signing/index.js';

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
export { isMobileBrowser, getAppStoreUrl, attemptWalletRedirect } from './utils/platform.js';
export {
  RESTRICTED_METHODS,
  UNRESTRICTED_METHODS,
  DEFAULT_RELAY_URL,
  PROTOCOL_VERSION,
} from './config.js';

// Convenience alias
export { QRLConnectProvider as QRLConnect } from './QRLConnectProvider.js';
