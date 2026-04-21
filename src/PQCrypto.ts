/**
 * Post-quantum crypto primitives for the QRL Connect protocol v2.
 *
 * - KEM:  ML-KEM-768 (FIPS 203, NIST Level 3) via @noble/post-quantum
 * - KDF:  HKDF-SHA-256 via WebCrypto SubtleCrypto
 * - AEAD: AES-256-GCM via WebCrypto SubtleCrypto
 *
 * The session key is bound to the full handshake transcript
 * (LABEL || cid || pk || ct) so ML-KEM's malicious-peer unknown-key-share
 * vulnerabilities (Cremers-Dax-Naska; Fiedler-Günther) cannot produce a
 * key agreement with inconsistent identities across sessions.
 *
 * IMPORTANT: ml-kem decapsulate() NEVER throws on tampered ciphertext — it
 * returns a pseudo-random shared secret via FIPS 203 implicit rejection.
 * Detect tampering exclusively at the AEAD authentication tag.
 */

import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';

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

export interface Keypair {
  pk: Uint8Array;
  sk: Uint8Array;
}

export interface EncapsResult {
  ct: Uint8Array;
  ss: Uint8Array;
}

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c || !c.subtle) {
    throw new Error('PQCrypto: WebCrypto SubtleCrypto is not available in this environment');
  }
  return c.subtle;
}

// WebCrypto's BufferSource in TS 5.x narrows to ArrayBufferView<ArrayBuffer>,
// while noble-post-quantum returns plain Uint8Array (inferred as
// Uint8Array<ArrayBufferLike>). The backing is always a fresh ArrayBuffer at
// runtime; normalize at the WebCrypto boundary.
function bs(u: Uint8Array): BufferSource {
  return u as unknown as BufferSource;
}

export function kemKeygen(): Keypair {
  const { publicKey, secretKey } = ml_kem768.keygen();
  return { pk: publicKey, sk: secretKey };
}

export function kemEncaps(pk: Uint8Array): EncapsResult {
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(pk);
  return { ct: cipherText, ss: sharedSecret };
}

export function kemDecaps(sk: Uint8Array, ct: Uint8Array): Uint8Array {
  return ml_kem768.decapsulate(ct, sk);
}

export async function transcriptHash(
  cid: Uint8Array,
  pk: Uint8Array,
  ct: Uint8Array
): Promise<Uint8Array> {
  const buf = concat(LABEL, cid, pk, ct);
  return new Uint8Array(await subtle().digest('SHA-256', bs(buf)));
}

export async function deriveAeadKey(ss: Uint8Array, htx: Uint8Array): Promise<CryptoKey> {
  const ikm = await subtle().importKey('raw', bs(ss), 'HKDF', false, ['deriveKey']);
  const info = concat(LABEL, LABEL_AEAD_SUFFIX, htx);
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: bs(info) },
    ikm,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

export async function importRawAeadKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== AEAD_KEY_LEN) {
    throw new Error(`PQCrypto: raw AEAD key must be ${AEAD_KEY_LEN} bytes`);
  }
  return subtle().importKey('raw', bs(raw), { name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
}

export async function exportRawAeadKey(key: CryptoKey): Promise<Uint8Array> {
  const buf = await subtle().exportKey('raw', key);
  return new Uint8Array(buf);
}

export function nonce(dir: Uint8Array, seq: number): Uint8Array {
  if (dir.length !== 4) {
    throw new Error('PQCrypto: direction tag must be 4 bytes');
  }
  const n = new Uint8Array(12);
  n.set(dir, 0);
  new DataView(n.buffer).setBigUint64(4, BigInt(seq), true);
  return n;
}

export function aad(htx: Uint8Array, seq: number): Uint8Array {
  const out = new Uint8Array(htx.length + 8);
  out.set(htx, 0);
  new DataView(out.buffer).setBigUint64(htx.length, BigInt(seq), true);
  return out;
}

export async function seal(
  key: CryptoKey,
  dir: Uint8Array,
  seq: number,
  htx: Uint8Array,
  pt: Uint8Array
): Promise<Uint8Array> {
  const ct = await subtle().encrypt(
    { name: 'AES-GCM', iv: bs(nonce(dir, seq)), additionalData: bs(aad(htx, seq)) },
    key,
    bs(pt)
  );
  return new Uint8Array(ct);
}

export async function open(
  key: CryptoKey,
  dir: Uint8Array,
  seq: number,
  htx: Uint8Array,
  ct: Uint8Array
): Promise<Uint8Array> {
  const pt = await subtle().decrypt(
    { name: 'AES-GCM', iv: bs(nonce(dir, seq)), additionalData: bs(aad(htx, seq)) },
    key,
    bs(ct)
  );
  return new Uint8Array(pt);
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
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function constantTimeEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
