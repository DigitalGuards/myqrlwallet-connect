/**
 * Post-quantum protocol composition for QRL Connect v3.
 *
 * - KEM:  ML-KEM-768 (FIPS 203, NIST Level 3)
 * - KDF:  HKDF-SHA-256
 * - AEAD: AES-256-GCM
 *
 * All primitive operations live behind src/crypto/primitives.ts (the single
 * file allowed to import crypto implementations or touch WebCrypto). This
 * module only composes them: transcript binding, nonce/AAD construction,
 * and the seal/open envelope.
 *
 * The session key is bound to the full handshake transcript plus a 32-byte
 * capability carried only in the QR/deep link. The capability is also the
 * HKDF salt, so a relay that knows cid, pk, ct, and even a chosen shared
 * secret cannot impersonate the wallet without possessing the out-of-band
 * pairing URI.
 *
 * IMPORTANT: ml-kem decapsulation NEVER throws on tampered ciphertext; it
 * returns a pseudo-random shared secret via FIPS 203 implicit rejection.
 * Detect tampering exclusively at the AEAD authentication tag.
 */

import {
  type EncapsResult,
  type Keypair,
  aesGcmDecrypt,
  aesGcmEncrypt,
  constantTimeEquals,
  exportAesGcmKey,
  hkdfAesGcmKey,
  importAesGcmKey,
  mlkemDecaps,
  mlkemEncaps,
  mlkemKeygen,
  randomBytes,
  sha256,
} from './crypto/primitives.js';
import { PAIRING_CAPABILITY_LEN } from './config.js';

export { constantTimeEquals, type EncapsResult, type Keypair };

const textEncoder = new TextEncoder();

export const LABEL = textEncoder.encode('pq-pair/v3');
const LABEL_AEAD_SUFFIX = textEncoder.encode(' aead');

export const DIR_DAPP_TX = new Uint8Array([0, 0, 0, 1]);
export const DIR_WALLET_TX = new Uint8Array([0, 0, 0, 2]);

export const ML_KEM_768_PK_LEN = 1184;
export const ML_KEM_768_SK_LEN = 2400;
export const ML_KEM_768_CT_LEN = 1088;
export const SHARED_SECRET_LEN = 32;
export const AEAD_KEY_LEN = 32;

function requireLength(name: string, value: Uint8Array, expected: number): void {
  if (value.length !== expected) {
    throw new Error(`PQCrypto: ${name} must be ${expected} bytes`);
  }
}

export function generatePairingCapability(): Uint8Array {
  return randomBytes(PAIRING_CAPABILITY_LEN);
}

export function kemKeygen(): Keypair {
  return mlkemKeygen();
}

export function kemEncaps(pk: Uint8Array): EncapsResult {
  return mlkemEncaps(pk);
}

export function kemDecaps(sk: Uint8Array, ct: Uint8Array): Uint8Array {
  return mlkemDecaps(sk, ct);
}

export async function transcriptHash(
  cid: Uint8Array,
  pk: Uint8Array,
  ct: Uint8Array,
  capability: Uint8Array
): Promise<Uint8Array> {
  requireLength('cid', cid, 16);
  requireLength('ML-KEM public key', pk, ML_KEM_768_PK_LEN);
  requireLength('ML-KEM ciphertext', ct, ML_KEM_768_CT_LEN);
  requireLength('pairing capability', capability, PAIRING_CAPABILITY_LEN);
  const preimage = concat(LABEL, cid, pk, ct, capability);
  try {
    return await sha256(preimage);
  } finally {
    zeroize(preimage);
  }
}

export async function deriveAeadKey(
  ss: Uint8Array,
  htx: Uint8Array,
  capability: Uint8Array
): Promise<CryptoKey> {
  requireLength('shared secret', ss, SHARED_SECRET_LEN);
  requireLength('transcript hash', htx, 32);
  requireLength('pairing capability', capability, PAIRING_CAPABILITY_LEN);
  const info = concat(LABEL, LABEL_AEAD_SUFFIX, htx);
  const salt = capability.slice();
  try {
    return await hkdfAesGcmKey(ss, salt, info);
  } finally {
    zeroize(salt);
    zeroize(info);
  }
}

export async function importRawAeadKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== AEAD_KEY_LEN) {
    throw new Error(`PQCrypto: raw AEAD key must be ${AEAD_KEY_LEN} bytes`);
  }
  return importAesGcmKey(raw);
}

export async function exportRawAeadKey(key: CryptoKey): Promise<Uint8Array> {
  return exportAesGcmKey(key);
}

export function nonce(dir: Uint8Array, seq: number): Uint8Array {
  if (dir.length !== 4) {
    throw new Error('PQCrypto: direction tag must be 4 bytes');
  }
  const n = new Uint8Array(12);
  n.set(dir, 0);
  new DataView(n.buffer, n.byteOffset, n.byteLength).setBigUint64(4, BigInt(seq), true);
  return n;
}

export function aad(htx: Uint8Array, seq: number): Uint8Array {
  const out = new Uint8Array(htx.length + 8);
  out.set(htx, 0);
  new DataView(out.buffer, out.byteOffset, out.byteLength).setBigUint64(
    htx.length,
    BigInt(seq),
    true
  );
  return out;
}

export async function seal(
  key: CryptoKey,
  dir: Uint8Array,
  seq: number,
  htx: Uint8Array,
  pt: Uint8Array
): Promise<Uint8Array> {
  return aesGcmEncrypt(key, nonce(dir, seq), aad(htx, seq), pt);
}

export async function open(
  key: CryptoKey,
  dir: Uint8Array,
  seq: number,
  htx: Uint8Array,
  ct: Uint8Array
): Promise<Uint8Array> {
  return aesGcmDecrypt(key, nonce(dir, seq), aad(htx, seq), ct);
}

export function zeroize(b: Uint8Array): void {
  b.fill(0);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  // Chunk to avoid `String.fromCharCode(...bytes)` spread-call stack limits
  // on long arrays (~100 KB+), while still amortizing per-char concatenation.
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    bin += String.fromCharCode.apply(null, Array.from(slice));
  }
  return btoa(bin);
}

export function base64EncodedLength(decodedLength: number): number {
  if (!Number.isSafeInteger(decodedLength) || decodedLength < 0) {
    throw new Error('PQCrypto: decoded base64 length must be a non-negative safe integer');
  }
  return Math.ceil(decodedLength / 3) * 4;
}

const PADDED_BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Validate exact padded-base64 shape before decoding. The encoded-length
 * comparison is the allocation bound; the re-encode check rejects non-canonical
 * unused bits after a bounded decode.
 */
export function isCanonicalBase64OfLength(value: unknown, decodedLength: number): value is string {
  if (
    typeof value !== 'string' ||
    value.length !== base64EncodedLength(decodedLength) ||
    !PADDED_BASE64_RE.test(value)
  ) {
    return false;
  }
  let decoded: Uint8Array | null = null;
  try {
    decoded = fromBase64(value);
    return decoded.length === decodedLength && toBase64(decoded) === value;
  } catch {
    return false;
  } finally {
    if (decoded) zeroize(decoded);
  }
}

/** Decode only an exact, canonical, allocation-bounded base64 value. */
export function fromBase64Exact(
  value: string,
  decodedLength: number,
  fieldName = 'value'
): Uint8Array {
  if (!isCanonicalBase64OfLength(value, decodedLength)) {
    throw new Error(`PQCrypto: ${fieldName} must encode exactly ${decodedLength} bytes`);
  }
  return fromBase64(value);
}

export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
