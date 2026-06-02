/**
 * Public signing surface re-exported from the SDK's top-level index.
 * dApps verify wallet responses with these; they never sign here.
 */

export {
  SCHEME_VERSION_MSG,
  SCHEME_VERSION_TYPED,
  SCHEME_TAG_MSG,
  SCHEME_TAG_TYPED,
  DIGEST_LEN,
} from './ctx.js';

export { computeMessageDigest } from './messageDigest.js';

export {
  encodeType,
  typeHash,
  hashStruct,
  encodeField,
  computeTypedDataDigest,
  type TypedDataPayload,
  type TypeMap,
  type StructDef,
  type TypedField,
  type Domain,
  type Message,
} from './typedData.js';

export {
  verifyMessage,
  verifyTypedData,
  type VerifyMessageParams,
  type VerifyTypedDataParams,
} from './verify.js';

export { bytesToHex, hexToBytes, concatBytes, concatBytesArr } from './bytes.js';
