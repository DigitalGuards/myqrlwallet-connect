/**
 * Stateless verifiers for the two PQ signing schemes. The SDK exposes these
 * so a dApp can re-verify the rich response object returned by the wallet
 * without round-tripping back through the relay. The lower-level
 * verifyMessageSignature / verifyTypedDataSignature prove only that a
 * supplied public key made the signature. Authorization decisions should use
 * the ForSigner variants, which also bind that key to the expected
 * current-format address.
 */

import { mldsaVerify, shake256Digest } from '../crypto/primitives.js';
import { isCurrentQrlAddress, qip55AddressFromBytes, QRL_ADDRESS_BYTES } from '../config.js';
import { SCHEME_TAG_MSG, SCHEME_TAG_TYPED } from './ctx.js';
import { computeMessageDigest } from './messageDigest.js';
import { computeTypedDataDigest, type TypedDataPayload } from './typedData.js';
import { concatBytes, hexToBytes } from './bytes.js';

const ML_DSA_87_DESCRIPTOR_TYPE = 1;
export const ML_DSA_DESCRIPTOR_BYTES = 3;
export const ML_DSA_87_PUBLIC_KEY_BYTES = 2592;
export const ML_DSA_87_SIGNATURE_BYTES = 4627;

function bytesOrHex(v: Uint8Array | string): Uint8Array {
  if (v instanceof Uint8Array) return new Uint8Array(v);
  if (typeof v === 'string') return hexToBytes(v);
  throw new Error('expected Uint8Array or 0x-hex string');
}

function fixedBytesOrHex(
  value: Uint8Array | string,
  expectedBytes: number
): Uint8Array | undefined {
  if (value instanceof Uint8Array) {
    return value.length === expectedBytes ? new Uint8Array(value) : undefined;
  }
  if (
    typeof value !== 'string' ||
    value.length !== expectedBytes * 2 + 2 ||
    !/^0x[0-9a-fA-F]+$/.test(value)
  ) {
    return undefined;
  }
  return hexToBytes(value);
}

function verifyMessageBytes(
  signature: Uint8Array,
  publicKey: Uint8Array,
  messageBytes: Uint8Array
): boolean {
  const digest = computeMessageDigest(messageBytes);
  return mldsaVerify(signature, digest, publicKey, SCHEME_TAG_MSG);
}

function verifyTypedDataBytes(
  signature: Uint8Array,
  publicKey: Uint8Array,
  payload: TypedDataPayload
): boolean {
  const digest = computeTypedDataDigest(payload);
  return mldsaVerify(signature, digest, publicKey, SCHEME_TAG_TYPED);
}

export interface VerifyMessageParams {
  signature: Uint8Array | string;
  publicKey: Uint8Array | string;
  /** 0x-hex bytes that were originally signed. */
  messageBytes: Uint8Array | string;
}

/**
 * Verify against an explicitly supplied ML-DSA public key only. This does not
 * prove that the key derives the signer claimed by a wallet response. Use
 * verifyMessageForSigner for authentication or authorization decisions.
 */
export function verifyMessageSignature({
  signature,
  publicKey,
  messageBytes,
}: VerifyMessageParams): boolean {
  try {
    const sig = fixedBytesOrHex(signature, ML_DSA_87_SIGNATURE_BYTES);
    const pk = fixedBytesOrHex(publicKey, ML_DSA_87_PUBLIC_KEY_BYTES);
    if (!sig || !pk) return false;
    const msg = bytesOrHex(messageBytes);
    return verifyMessageBytes(sig, pk, msg);
  } catch {
    return false;
  }
}

export interface VerifyTypedDataParams {
  signature: Uint8Array | string;
  publicKey: Uint8Array | string;
  payload: TypedDataPayload;
}

/**
 * Verify against an explicitly supplied ML-DSA public key only. This does not
 * bind that key to a Q-address. Use verifyTypedDataForSigner when signer
 * identity matters.
 */
export function verifyTypedDataSignature({
  signature,
  publicKey,
  payload,
}: VerifyTypedDataParams): boolean {
  try {
    const sig = fixedBytesOrHex(signature, ML_DSA_87_SIGNATURE_BYTES);
    const pk = fixedBytesOrHex(publicKey, ML_DSA_87_PUBLIC_KEY_BYTES);
    if (!sig || !pk) return false;
    return verifyTypedDataBytes(sig, pk, payload);
  } catch {
    return false;
  }
}

function publicKeyMatchesSigner(
  expectedSigner: string,
  descriptor: Uint8Array,
  publicKey: Uint8Array
): boolean {
  if (!isCurrentQrlAddress(expectedSigner)) return false;
  if (descriptor[0] !== ML_DSA_87_DESCRIPTOR_TYPE) {
    return false;
  }
  const addressBytes = shake256Digest(concatBytes(descriptor, publicKey), QRL_ADDRESS_BYTES);
  const derived = qip55AddressFromBytes(addressBytes);
  return derived.toLowerCase() === expectedSigner.toLowerCase();
}

export interface VerifyMessageForSignerParams extends VerifyMessageParams {
  /** QIP-55 Q + 128 hex address expected by the dApp. */
  expectedSigner: string;
  /** Exact 3-byte wallet descriptor. Missing legacy values fail closed. */
  descriptor?: Uint8Array | string | undefined;
}

/** Verify both the message signature and public-key-to-signer binding. */
export function verifyMessageForSigner({
  expectedSigner,
  descriptor,
  signature,
  publicKey,
  messageBytes,
}: VerifyMessageForSignerParams): boolean {
  try {
    if (descriptor === undefined) return false;
    const descriptorBytes = fixedBytesOrHex(descriptor, ML_DSA_DESCRIPTOR_BYTES);
    const publicKeyBytes = fixedBytesOrHex(publicKey, ML_DSA_87_PUBLIC_KEY_BYTES);
    const signatureBytes = fixedBytesOrHex(signature, ML_DSA_87_SIGNATURE_BYTES);
    if (!descriptorBytes || !publicKeyBytes || !signatureBytes) return false;
    const message = bytesOrHex(messageBytes);
    return (
      publicKeyMatchesSigner(expectedSigner, descriptorBytes, publicKeyBytes) &&
      verifyMessageBytes(signatureBytes, publicKeyBytes, message)
    );
  } catch {
    return false;
  }
}

export interface VerifyTypedDataForSignerParams extends VerifyTypedDataParams {
  /** QIP-55 Q + 128 hex address expected by the dApp. */
  expectedSigner: string;
  /** Exact 3-byte wallet descriptor. Missing legacy values fail closed. */
  descriptor?: Uint8Array | string | undefined;
}

/** Verify both the typed-data signature and public-key-to-signer binding. */
export function verifyTypedDataForSigner({
  expectedSigner,
  descriptor,
  signature,
  publicKey,
  payload,
}: VerifyTypedDataForSignerParams): boolean {
  try {
    if (descriptor === undefined) return false;
    const descriptorBytes = fixedBytesOrHex(descriptor, ML_DSA_DESCRIPTOR_BYTES);
    const publicKeyBytes = fixedBytesOrHex(publicKey, ML_DSA_87_PUBLIC_KEY_BYTES);
    const signatureBytes = fixedBytesOrHex(signature, ML_DSA_87_SIGNATURE_BYTES);
    if (!descriptorBytes || !publicKeyBytes || !signatureBytes) return false;
    return (
      publicKeyMatchesSigner(expectedSigner, descriptorBytes, publicKeyBytes) &&
      verifyTypedDataBytes(signatureBytes, publicKeyBytes, payload)
    );
  } catch {
    return false;
  }
}

/**
 * @deprecated Use verifyMessageSignature for a key-only check, or
 * verifyMessageForSigner when signer identity matters.
 */
export function verifyMessage(params: VerifyMessageParams): boolean {
  return verifyMessageSignature(params);
}

/**
 * @deprecated Use verifyTypedDataSignature for a key-only check, or
 * verifyTypedDataForSigner when signer identity matters.
 */
export function verifyTypedData(params: VerifyTypedDataParams): boolean {
  return verifyTypedDataSignature(params);
}
