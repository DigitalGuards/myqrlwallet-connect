/**
 * Post-quantum protocol composition for QRL Connect v2.
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
 * The session key is bound to the full handshake transcript
 * (LABEL || cid || pk || ct) so ML-KEM's malicious-peer unknown-key-share
 * vulnerabilities (Cremers-Dax-Naska; Fiedler-Gunther) cannot produce a
 * key agreement with inconsistent identities across sessions.
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
  sha256,
} from './crypto/primitives.js';

export { constantTimeEquals, type EncapsResult, type Keypair };

const textEncoder = new TextEncoder();

export const LABEL = textEncoder.encode('pq-pair/v1');
const LABEL_AEAD_SUFFIX = textEncoder.encode(' aead');

export const DIR_DAPP_TX = new Uint8Array([0, 0, 0, 1]);
export const DIR_WALLET_TX = new Uint8Array([0, 0, 0, 2]);

export const ML_KEM_768_PK_LEN = 1184;
export const ML_KEM_768_SK_LEN = 2400;
export const ML_KEM_768_CT_LEN = 1088;
export const SHARED_SECRET_LEN = 32;
export const AEAD_KEY_LEN = 32;

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
  ct: Uint8Array
): Promise<Uint8Array> {
  return sha256(concat(LABEL, cid, pk, ct));
}

export async function deriveAeadKey(ss: Uint8Array, htx: Uint8Array): Promise<CryptoKey> {
  const info = concat(LABEL, LABEL_AEAD_SUFFIX, htx);
  return hkdfAesGcmKey(ss, new Uint8Array(32), info);
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

export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
