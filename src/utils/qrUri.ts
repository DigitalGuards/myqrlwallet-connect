/**
 * v3 QR URI codec (PQP3).
 *
 * Format: qrlconnect://?q=<base45(PQP3 || cid || fp || cap)>[&r=<relayUrl>]
 *
 *   PQP3 = "PQP3" magic                                        (4 B)
 *   cid  = 16 bytes (UUIDv4 raw)                               (16 B)
 *   fp   = SHA-256("pq-fp/v3" || cid || pk || cap) (full 32B) (32 B)
 *   cap  = fresh CSPRNG pairing capability                     (32 B)
 *   total                                                       (84 B)
 *
 * The capability is a bearer secret. It is never uploaded to the relay and
 * must not be logged or persisted before the handshake consumes it.
 *
 * Security: the public key is NOT carried in the QR. It's uploaded by the
 * dApp to the relay at channel creation, the relay binds it to the cid, and
 * the wallet fetches it via the join_channel ack. The fingerprint commits
 * the relay-served key to the exact out-of-band capability. The capability
 * is also bound into the transcript and HKDF by the key-exchange layer, so a
 * relay cannot fabricate an authenticated wallet hello.
 *
 * Legacy PQP1 and PQP2 URIs are rejected with a clear migration error. This
 * intentional v4.0 break prevents fallback to a pairing mode where the relay
 * could impersonate a wallet.
 */

import { base45Decode, base45Encode } from './base45.js';
import { constantTimeEquals, randomBytes, sha256 } from '../crypto/primitives.js';
import { PAIRING_CAPABILITY_LEN, normalizeRelayUrl } from '../config.js';
import { ML_KEM_768_PK_LEN } from '../PQCrypto.js';

const MAGIC = new Uint8Array([0x50, 0x51, 0x50, 0x33]); // "PQP3"
const FP_LABEL = new TextEncoder().encode('pq-fp/v3');

export const CID_LEN = 16;
export const FP_LEN = 32;
export const CAP_LEN = PAIRING_CAPABILITY_LEN;
export const BLOB_LEN = 4 + CID_LEN + FP_LEN + CAP_LEN; // 84
export const MAX_CONNECTION_URI_LENGTH = 4096;

/**
 * Compute the full 32-byte fingerprint binding (label || cid || pk || cap).
 * Exported so the wallet side can re-derive and verify.
 */
export async function computeFingerprint(
  cid: Uint8Array,
  pk: Uint8Array,
  capability: Uint8Array
): Promise<Uint8Array> {
  if (cid.length !== CID_LEN) {
    throw new Error(`qrUri: cid must be ${CID_LEN} bytes`);
  }
  if (pk.length !== ML_KEM_768_PK_LEN) {
    throw new Error(`qrUri: ML-KEM public key must be ${ML_KEM_768_PK_LEN} bytes`);
  }
  if (capability.length !== CAP_LEN) {
    throw new Error(`qrUri: capability must be ${CAP_LEN} bytes`);
  }
  const buf = new Uint8Array(FP_LABEL.length + cid.length + pk.length + capability.length);
  buf.set(FP_LABEL, 0);
  buf.set(cid, FP_LABEL.length);
  buf.set(pk, FP_LABEL.length + cid.length);
  buf.set(capability, FP_LABEL.length + cid.length + pk.length);
  try {
    return await sha256(buf);
  } finally {
    buf.fill(0);
  }
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
 * Encode (cid, pk, capability) as a qrlconnect:// URI. The PK is not stored
 * in the URI; only its capability-bound fingerprint is embedded. The caller
 * must upload the PK to the relay separately before publishing this URI.
 *
 * The optional `relayUrl` rides as a sibling query param (not inside the
 * fp-bound blob) so a tampered relay can cause the pairing to fail but
 * cannot substitute the PK - the fp still pins that.
 */
export async function generateConnectionURI(
  cid: Uint8Array,
  pk: Uint8Array,
  capability: Uint8Array,
  relayUrl?: string
): Promise<string> {
  if (cid.length !== CID_LEN) {
    throw new Error(`qrUri: cid must be ${CID_LEN} bytes (got ${cid.length})`);
  }
  if (pk.length !== ML_KEM_768_PK_LEN) {
    throw new Error(
      `qrUri: ML-KEM public key must be ${ML_KEM_768_PK_LEN} bytes (got ${pk.length})`
    );
  }
  if (capability.length !== CAP_LEN) {
    throw new Error(`qrUri: capability must be ${CAP_LEN} bytes (got ${capability.length})`);
  }
  const stableCapability = capability.slice();
  const blob = new Uint8Array(BLOB_LEN);
  try {
    const fp = await computeFingerprint(cid, pk, stableCapability);
    blob.set(MAGIC, 0);
    blob.set(cid, 4);
    blob.set(fp, 4 + CID_LEN);
    blob.set(stableCapability, 4 + CID_LEN + FP_LEN);
    // URL-encode: the base45 alphabet contains `+`, ` `, `%` which would
    // otherwise be mangled by URLSearchParams parsing on the wallet side.
    const params = new URLSearchParams({ q: base45Encode(blob) });
    if (relayUrl !== undefined) params.set('r', normalizeRelayUrl(relayUrl));
    return `qrlconnect://?${params.toString()}`;
  } finally {
    stableCapability.fill(0);
    blob.fill(0);
  }
}

export interface ParsedURI {
  cid: Uint8Array;
  fp: Uint8Array;
  capability: Uint8Array;
  relayUrl?: string | undefined;
}

/**
 * Parse a qrlconnect:// URI into (cid, fp, capability, relayUrl?). The caller
 * owns and must eventually wipe the returned capability. This function
 * rejects legacy pairings, oversized input, and ambiguous duplicate params.
 */
// The PQP1 magic we recognise in legacy blobs to give a targeted error.
// Full-width check avoids false-positives on random 1208-byte payloads
// whose 4th byte happens to be ASCII '1'.
const PQP1_MAGIC = new Uint8Array([0x50, 0x51, 0x50, 0x31]);
const PQP2_MAGIC = new Uint8Array([0x50, 0x51, 0x50, 0x32]);

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
  if (uri.length > MAX_CONNECTION_URI_LENGTH) {
    throw new Error(`qrUri: URI exceeds ${MAX_CONNECTION_URI_LENGTH} characters`);
  }
  if (!uri.startsWith('qrlconnect:')) {
    throw new Error('qrUri: not a qrlconnect URI');
  }
  if (!uri.startsWith('qrlconnect://?') || uri.includes('#')) {
    throw new Error('qrUri: URI must use canonical qrlconnect://? query form');
  }
  let params: URLSearchParams;
  try {
    const parsed = new URL(uri);
    if (
      parsed.protocol !== 'qrlconnect:' ||
      parsed.host !== '' ||
      parsed.pathname !== '' ||
      parsed.hash !== ''
    ) {
      throw new Error('non-canonical URI components');
    }
    params = parsed.searchParams;
  } catch {
    throw new Error('qrUri: malformed URI');
  }

  if (params.has('channelId') || params.has('pubKey')) {
    throw new Error(
      'qrUri: legacy v1 URI detected - this wallet and this dApp must both run protocol v3'
    );
  }
  if (params.getAll('q').length > 1 || params.getAll('r').length > 1) {
    throw new Error('qrUri: duplicate q or r parameter');
  }
  for (const key of params.keys()) {
    if (key !== 'q' && key !== 'r') {
      throw new Error(`qrUri: unknown parameter ${key}`);
    }
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

  try {
    if (blob.length !== BLOB_LEN) {
      // Distinguish known legacy layouts from random gibberish so callers get
      // a useful migration error without accepting an unauthenticated mode.
      if (blob.length === 1208 && startsWith(blob, PQP1_MAGIC)) {
        throw new Error(
          'qrUri: legacy PQP1 URI detected - regenerate the QR with a v4.0+ dApp SDK'
        );
      }
      if (blob.length === 52 && startsWith(blob, PQP2_MAGIC)) {
        throw new Error(
          'qrUri: legacy PQP2 URI detected - regenerate the QR with a v4.0+ dApp SDK'
        );
      }
      throw new Error(`qrUri: expected ${BLOB_LEN}-byte blob, got ${blob.length}`);
    }

    if (!startsWith(blob, MAGIC)) {
      throw new Error('qrUri: bad PQP3 magic');
    }

    const cid = blob.slice(4, 4 + CID_LEN);
    const fp = blob.slice(4 + CID_LEN, 4 + CID_LEN + FP_LEN);
    const capability = blob.slice(4 + CID_LEN + FP_LEN, BLOB_LEN);
    const r = params.get('r');
    let relayUrl: string | undefined;
    if (r !== null) {
      if (r === '') throw new Error('qrUri: empty relay URL');
      try {
        relayUrl = normalizeRelayUrl(r);
      } catch {
        throw new Error('qrUri: invalid relay URL');
      }
    }
    return { cid, fp, capability, relayUrl };
  } finally {
    blob.fill(0);
  }
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
