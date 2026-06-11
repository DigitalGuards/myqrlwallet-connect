/**
 * v2 QR URI codec (PQP2).
 *
 * Format: qrlconnect://?q=<base45(PQP2 || cid || fp)>[&r=<relayUrl>]
 *
 *   PQP2 = "PQP2" magic                                 (4 B)
 *   cid  = 16 bytes (UUIDv4 raw)                        (16 B)
 *   fp   = SHA-256("pq-fp/v2" || cid || pk) (full 32B)  (32 B)
 *   total                                               (52 B)
 *
 * 52 bytes → ~78 alphanumeric chars after base45 → URI under 150 chars →
 * fits a version-5 QR at ECC-M. Scannable from any 2015-vintage camera.
 *
 * Security: the public key is NOT carried in the QR. It's uploaded by the
 * dApp to the relay at channel creation, the relay binds it to the cid, and
 * the wallet fetches it via the join_channel ack. The 32-byte fp acts as
 * the out-of-band commitment: the wallet rejects the PK served by the relay
 * unless SHA-256("pq-fp/v2" || cid || pk) matches the fp from the QR.
 * Full-width SHA-256 (2^128 collision resistance) rules out brute-force
 * substitution of a maliciously-crafted PK with the same fingerprint.
 *
 * Legacy v2.0 URIs (magic=PQP1, 1208-byte blob with embedded PK) are
 * rejected with a clear error by parseConnectionURI - this is a hard
 * break before 2.0.0 ships, no backcompat.
 */

import { base45Decode, base45Encode } from './base45.js';
import { constantTimeEquals, randomBytes, sha256 } from '../crypto/primitives.js';

const MAGIC = new Uint8Array([0x50, 0x51, 0x50, 0x32]); // "PQP2"
const FP_LABEL = new TextEncoder().encode('pq-fp/v2');

export const CID_LEN = 16;
export const FP_LEN = 32;
export const BLOB_LEN = 4 + CID_LEN + FP_LEN; // 52

/**
 * Compute the full 32-byte fingerprint binding (label || cid || pk).
 * Exported so the wallet side can re-derive and verify.
 */
export async function computeFingerprint(cid: Uint8Array, pk: Uint8Array): Promise<Uint8Array> {
  if (cid.length !== CID_LEN) {
    throw new Error(`qrUri: cid must be ${CID_LEN} bytes`);
  }
  const buf = new Uint8Array(FP_LABEL.length + cid.length + pk.length);
  buf.set(FP_LABEL, 0);
  buf.set(cid, FP_LABEL.length);
  buf.set(pk, FP_LABEL.length + cid.length);
  return sha256(buf);
}

/**
 * Constant-time comparison of two byte arrays. Both must be the same length.
 * The verifier MUST use this rather than `===` or `indexOf` so timing signals
 * don't leak which byte of `fp` diverged first.
 */
export function fingerprintEquals(a: Uint8Array, b: Uint8Array): boolean {
  return constantTimeEquals(a, b);
}

/**
 * Encode (cid, pk) as a qrlconnect:// URI. Note the PK is not stored in the
 * URI - we compute its fingerprint and embed only that. The caller must
 * upload the PK to the relay separately before publishing this URI.
 *
 * The optional `relayUrl` rides as a sibling query param (not inside the
 * fp-bound blob) so a tampered relay can cause the pairing to fail but
 * cannot substitute the PK - the fp still pins that.
 */
export async function generateConnectionURI(
  cid: Uint8Array,
  pk: Uint8Array,
  relayUrl?: string
): Promise<string> {
  if (cid.length !== CID_LEN) {
    throw new Error(`qrUri: cid must be ${CID_LEN} bytes (got ${cid.length})`);
  }
  const fp = await computeFingerprint(cid, pk);
  const blob = new Uint8Array(BLOB_LEN);
  blob.set(MAGIC, 0);
  blob.set(cid, 4);
  blob.set(fp, 4 + CID_LEN);
  // URL-encode: the base45 alphabet contains `+`, ` `, `%` which would
  // otherwise be mangled by URLSearchParams parsing on the wallet side.
  const params = new URLSearchParams({ q: base45Encode(blob) });
  if (relayUrl) params.set('r', relayUrl);
  return `qrlconnect://?${params.toString()}`;
}

export interface ParsedURI {
  cid: Uint8Array;
  fp: Uint8Array;
  relayUrl?: string | undefined;
}

/**
 * Parse a qrlconnect:// URI into (cid, fp, relayUrl?). Throws on malformed
 * blob or legacy PQP1/v1 URIs. The caller must still fetch the PK from the
 * relay and verify it against `fp` before trusting it - `parseConnectionURI`
 * only does syntactic validation here.
 */
// The PQP1 magic we recognise in legacy blobs to give a targeted error.
// Full-width check avoids false-positives on random 1208-byte payloads
// whose 4th byte happens to be ASCII '1'.
const PQP1_MAGIC = new Uint8Array([0x50, 0x51, 0x50, 0x31]);

function startsWith(buf: Uint8Array, prefix: Uint8Array): boolean {
  if (buf.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (buf[i] !== prefix[i]) return false;
  }
  return true;
}

// eslint-disable-next-line @typescript-eslint/require-await -- public API stays async; parsing may grow async verification steps without a breaking change
export async function parseConnectionURI(uri: string): Promise<ParsedURI> {
  if (typeof uri !== 'string' || uri.length === 0) {
    throw new Error('qrUri: empty URI');
  }
  if (!/^qrlconnect:/i.test(uri)) {
    throw new Error('qrUri: not a qrlconnect URI');
  }
  // Use WHATWG URL parsing (via a dummy http scheme swap since qrlconnect
  // isn't a registered special scheme) so we reject genuinely malformed
  // input like "qrlconnect:q=..." or fragments cleanly, and so parameter
  // extraction matches what a browser does with the same URI.
  let params: URLSearchParams;
  try {
    const swapped = new URL(uri.replace(/^qrlconnect:\/?\/?/i, 'https://qrlconnect/'));
    params = swapped.searchParams;
  } catch {
    throw new Error('qrUri: malformed URI');
  }

  if (params.has('channelId') || params.has('pubKey')) {
    throw new Error(
      'qrUri: legacy v1 URI detected - this wallet and this dApp must both run protocol v2'
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
    // Distinguish the most likely footgun - a PQP1 URI encoded under the
    // older 1208-byte layout - from random gibberish.
    if (blob.length === 1208 && startsWith(blob, PQP1_MAGIC)) {
      throw new Error('qrUri: legacy PQP1 URI detected - regenerate the QR with a v2.0+ dApp SDK');
    }
    throw new Error(`qrUri: expected ${BLOB_LEN}-byte blob, got ${blob.length}`);
  }

  if (!startsWith(blob, MAGIC)) {
    throw new Error('qrUri: bad PQP2 magic');
  }

  const cid = blob.slice(4, 4 + CID_LEN);
  const fp = blob.slice(4 + CID_LEN, 4 + CID_LEN + FP_LEN);
  const r = params.get('r');
  return { cid, fp, relayUrl: r === null || r === '' ? undefined : r };
}

/** Convert 16 raw cid bytes to RFC 4122 UUID hex string. */
export function cidToString(cid: Uint8Array): string {
  if (cid.length !== CID_LEN) {
    throw new Error(`cidToString: expected ${CID_LEN}-byte cid`);
  }
  let hex = '';
  for (let i = 0; i < CID_LEN; i++) {
    hex += (cid[i] ?? 0).toString(16).padStart(2, '0');
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
  return randomBytes(CID_LEN);
}
