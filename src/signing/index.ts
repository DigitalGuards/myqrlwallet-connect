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
  TYPED_DATA_LIMITS,
  type TypedDataPayload,
  type TypeMap,
  type StructDef,
  type TypedField,
  type Domain,
  type Message,
} from './typedData.js';

export {
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
  type VerifyMessageParams,
  type VerifyMessageForSignerParams,
  type VerifyTypedDataParams,
  type VerifyTypedDataForSignerParams,
} from './verify.js';

export { bytesToHex, hexToBytes, concatBytes, concatBytesArr } from './bytes.js';
