/**
 * Cryptographic primitive boundary.
 *
 * This is the ONLY file in the SDK allowed to import a cryptographic
 * implementation (@noble/*, @theqrl/mldsa87) or to touch the platform
 * WebCrypto object. Everything else in src/ composes protocol logic on top
 * of the functions exported here; an ESLint fence (no-restricted-imports +
 * no-restricted-syntax in .eslintrc.cjs) enforces the boundary so crypto
 * cannot quietly spread back into application code.
 *
 * Implementation inventory, i.e. what actually runs where:
 *   - AES-256-GCM, HKDF-SHA-256, SHA-256, CSPRNG: platform WebCrypto.
 *     Native code, outside the JS engine.
 *   - ML-KEM-768 (FIPS 203): @noble/post-quantum. Audited pure JS; browsers
 *     expose no WebCrypto ML-KEM yet and no equally-vetted WASM build exists.
 *   - SHAKE256: @noble/hashes. Audited pure JS.
 *   - ML-DSA-87 verify (FIPS 204): @theqrl/mldsa87. Pure JS port used across
 *     the QRL stack; the SDK only verifies, it never signs.
 *
 * Swapping any primitive for a native/WASM implementation is a change to
 * this file alone; callers see byte-identical outputs or they fail the
 * parity and KAT suites.
 */

import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { shake256 } from '@noble/hashes/sha3.js';
import * as mldsa from '@theqrl/mldsa87';

export interface Keypair {
  pk: Uint8Array;
  sk: Uint8Array;
}

export interface EncapsResult {
  ct: Uint8Array;
  ss: Uint8Array;
}

function webCrypto(): Crypto {
  const c = globalThis.crypto;
  if (!c) {
    throw new Error('crypto: WebCrypto is not available in this environment');
  }
  return c;
}

function subtle(): SubtleCrypto {
  const c = webCrypto();
  if (!c.subtle) {
    throw new Error('crypto: WebCrypto SubtleCrypto is not available in this environment');
  }
  return c.subtle;
}

// WebCrypto's BufferSource in TS 5.x narrows to ArrayBufferView<ArrayBuffer>,
// while the pure-JS libraries return Uint8Array<ArrayBufferLike>. Re-view the
// same bytes through an ArrayBuffer-typed handle so the WebCrypto boundary
// type-checks without a type assertion. SharedArrayBuffer-backed inputs are
// copied into a fresh ArrayBuffer.
function bs(u: Uint8Array): Uint8Array<ArrayBuffer> {
  if (u.buffer instanceof ArrayBuffer) {
    return new Uint8Array(u.buffer, u.byteOffset, u.byteLength);
  }
  const copy = new Uint8Array(u.byteLength);
  copy.set(u);
  return copy;
}

// ── ML-KEM-768 ────────────────────────────────────────────────

export function mlkemKeygen(): Keypair {
  const { publicKey, secretKey } = ml_kem768.keygen();
  return { pk: publicKey, sk: secretKey };
}

export function mlkemEncaps(pk: Uint8Array): EncapsResult {
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(pk);
  return { ct: cipherText, ss: sharedSecret };
}

/**
 * NOTE: never throws on tampered ciphertext. FIPS 203 implicit rejection
 * returns a pseudo-random shared secret instead; tampering is detected
 * exclusively at the AEAD authentication tag.
 */
export function mlkemDecaps(sk: Uint8Array, ct: Uint8Array): Uint8Array {
  return ml_kem768.decapsulate(ct, sk);
}

// ── Hashes ────────────────────────────────────────────────────

export function shake256Digest(data: Uint8Array, dkLen: number): Uint8Array {
  return shake256(data, { dkLen });
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest('SHA-256', bs(data)));
}

// ── ML-DSA-87 ─────────────────────────────────────────────────

export function mldsaVerify(
  signature: Uint8Array,
  digest: Uint8Array,
  publicKey: Uint8Array,
  ctx: Uint8Array
): boolean {
  return mldsa.cryptoSignVerify(signature, digest, publicKey, ctx);
}

// ── AES-256-GCM + HKDF-SHA-256 ────────────────────────────────

export async function hkdfAesGcmKey(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array
): Promise<CryptoKey> {
  const ikmKey = await subtle().importKey('raw', bs(ikm), 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: bs(salt), info: bs(info) },
    ikmKey,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

export async function importAesGcmKey(raw: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey('raw', bs(raw), { name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
}

export async function exportAesGcmKey(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await subtle().exportKey('raw', key));
}

export async function aesGcmEncrypt(
  key: CryptoKey,
  iv: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array
): Promise<Uint8Array> {
  const ct = await subtle().encrypt(
    { name: 'AES-GCM', iv: bs(iv), additionalData: bs(aad) },
    key,
    bs(plaintext)
  );
  return new Uint8Array(ct);
}

export async function aesGcmDecrypt(
  key: CryptoKey,
  iv: Uint8Array,
  aad: Uint8Array,
  ciphertext: Uint8Array
): Promise<Uint8Array> {
  const pt = await subtle().decrypt(
    { name: 'AES-GCM', iv: bs(iv), additionalData: bs(aad) },
    key,
    bs(ciphertext)
  );
  return new Uint8Array(pt);
}

// ── Randomness ────────────────────────────────────────────────

export function randomBytes(n: number): Uint8Array {
  const c = webCrypto();
  if (typeof c.getRandomValues !== 'function') {
    throw new Error('crypto: crypto.getRandomValues is not available');
  }
  return c.getRandomValues(new Uint8Array(n));
}

/**
 * RFC4122 v4 UUID string from CSPRNG bytes. Channel ids are bound into the
 * handshake transcript, so their randomness comes from this boundary rather
 * than a third-party uuid package.
 */
export function randomUuid(): string {
  const b = randomBytes(16);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ── Comparison ────────────────────────────────────────────────

/**
 * Best-effort constant-time comparison (JS engines give no hard guarantee,
 * but the access pattern is data-independent). Length mismatch returns early;
 * the lengths compared in this protocol are public.
 */
export function constantTimeEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return d === 0;
}
