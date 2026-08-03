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
  type QrlSignedResultWithDescriptor,
  type QrlSignedTypedDataResult,
  hasSigningDescriptor,
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
  TYPED_DATA_LIMITS,
  encodeType,
  typeHash,
  hashStruct,
  encodeField,
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- compatibility export
  verifyMessage,
  verifyMessageSignature,
  verifyMessageForSigner,
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- compatibility export
  verifyTypedData,
  verifyTypedDataSignature,
  verifyTypedDataForSigner,
  ML_DSA_DESCRIPTOR_BYTES,
  ML_DSA_87_PUBLIC_KEY_BYTES,
  ML_DSA_87_SIGNATURE_BYTES,
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
  type VerifyMessageForSignerParams,
  type VerifyTypedDataParams,
  type VerifyTypedDataForSignerParams,
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
  EXPLICITLY_UNSUPPORTED_METHODS,
  classifyRpcMethod,
  type RpcMethodPolicy,
  DEFAULT_RELAY_URL,
  PROTOCOL_VERSION,
} from './config.js';

// Convenience alias
export { QRLConnectProvider as QRLConnect } from './QRLConnectProvider.js';
