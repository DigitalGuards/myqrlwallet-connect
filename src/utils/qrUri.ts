/**
 * v2 QR URI codec.
 *
 * Format: qrlconnect://?q=<base45(PQP1 || cid || pk || fp)>
 *
 *   PQP1 = "PQP1" magic                           (4 B)
 *   cid  = 16 bytes (UUIDv4 raw)                  (16 B)
 *   pk   = ML-KEM-768 encapsulation key           (1184 B)
 *   fp   = SHA-256(pk)[0..4] UX-level redundancy  (4 B)
 *   total                                         (1208 B)
 *
 * The 1208-byte blob fits a v27 QR at ECC-M in alphanumeric mode.
 *
 * v1 URIs (qrlconnect://?channelId=...&pubKey=...) are rejected with a
 * clear error by parseConnectionURI.
 */

import { base45Decode, base45Encode } from './base45.js';

const MAGIC = new Uint8Array([0x50, 0x51, 0x50, 0x31]); // "PQP1"
export const CID_LEN = 16;
export const PK_LEN = 1184;
export const FP_LEN = 4;
export const BLOB_LEN = 4 + CID_LEN + PK_LEN + FP_LEN; // 1208

async function sha256First4(bytes: Uint8Array): Promise<Uint8Array> {
  const c = globalThis.crypto;
  if (!c || !c.subtle) {
    throw new Error('qrUri: WebCrypto SubtleCrypto is not available');
  }
  const digest = await c.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return new Uint8Array(digest).slice(0, FP_LEN);
}

/**
 * Encode (cid, pk) as a qrlconnect:// URI for QR / deep-link display.
 */
export async function generateConnectionURI(
  cid: Uint8Array,
  pk: Uint8Array
): Promise<string> {
  if (cid.length !== CID_LEN) {
    throw new Error(`qrUri: cid must be ${CID_LEN} bytes (got ${cid.length})`);
  }
  if (pk.length !== PK_LEN) {
    throw new Error(`qrUri: pk must be ${PK_LEN} bytes (got ${pk.length})`);
  }
  const fp = await sha256First4(pk);
  const blob = new Uint8Array(BLOB_LEN);
  blob.set(MAGIC, 0);
  blob.set(cid, 4);
  blob.set(pk, 20);
  blob.set(fp, 1204);
  // URL-encode: the base45 alphabet contains `+`, ` `, and `%` which would
  // otherwise be mangled by URLSearchParams parsing on the wallet side.
  const params = new URLSearchParams({ q: base45Encode(blob) });
  return `qrlconnect://?${params.toString()}`;
}

export interface ParsedURI {
  cid: Uint8Array;
  pk: Uint8Array;
}

/**
 * Parse a qrlconnect:// URI into (cid, pk). Throws on malformed blob,
 * fingerprint mismatch, or legacy v1 URIs.
 */
export async function parseConnectionURI(uri: string): Promise<ParsedURI> {
  if (typeof uri !== 'string' || uri.length === 0) {
    throw new Error('qrUri: empty URI');
  }
  if (!/^qrlconnect:/i.test(uri)) {
    throw new Error('qrUri: not a qrlconnect URI');
  }
  const stripped = uri.replace(/^qrlconnect:\/?\/?\??/i, '');
  const params = new URLSearchParams(stripped);

  if (params.has('channelId') || params.has('pubKey')) {
    throw new Error(
      'qrUri: legacy v1 URI detected — this wallet and this dApp must both run protocol v2'
    );
  }

  const q = params.get('q');
  if (!q) {
    throw new Error('qrUri: missing q parameter');
  }

  let blob: Uint8Array;
  try {
    blob = base45Decode(q);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`qrUri: base45 decode failed: ${msg}`);
  }

  if (blob.length !== BLOB_LEN) {
    throw new Error(`qrUri: expected ${BLOB_LEN}-byte blob, got ${blob.length}`);
  }

  for (let i = 0; i < MAGIC.length; i++) {
    if (blob[i] !== MAGIC[i]) {
      throw new Error('qrUri: bad PQP1 magic');
    }
  }

  const cid = blob.slice(4, 4 + CID_LEN);
  const pk = blob.slice(4 + CID_LEN, 4 + CID_LEN + PK_LEN);
  const fp = blob.slice(BLOB_LEN - FP_LEN, BLOB_LEN);

  const expected = await sha256First4(pk);
  let diff = 0;
  for (let i = 0; i < FP_LEN; i++) diff |= fp[i] ^ expected[i];
  if (diff !== 0) {
    throw new Error('qrUri: fingerprint mismatch');
  }

  return { cid, pk };
}

/** Convert 16 raw cid bytes to RFC 4122 UUID hex string. */
export function cidToString(cid: Uint8Array): string {
  if (cid.length !== CID_LEN) {
    throw new Error(`cidToString: expected ${CID_LEN}-byte cid`);
  }
  let hex = '';
  for (let i = 0; i < CID_LEN; i++) {
    hex += cid[i].toString(16).padStart(2, '0');
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Convert RFC 4122 UUID string to 16 raw cid bytes. */
export function cidFromString(s: string): Uint8Array {
  const hex = s.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) {
    throw new Error('cidFromString: not a 128-bit hex string');
  }
  const out = new Uint8Array(CID_LEN);
  for (let i = 0; i < CID_LEN; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Generate 16 random bytes for a fresh channel ID. */
export function cidRandom(): Uint8Array {
  const c = globalThis.crypto;
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new Error('qrUri: crypto.getRandomValues is not available');
  }
  return c.getRandomValues(new Uint8Array(CID_LEN));
}
