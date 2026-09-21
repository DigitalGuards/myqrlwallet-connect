import { shake256Digest } from '../crypto/primitives.js';

export const QRL_ADDRESS_BYTES = 64;
export const QRL_ADDRESS_HEX_LENGTH = QRL_ADDRESS_BYTES * 2;

const QRL_ADDRESS_RE = new RegExp(`^Q[0-9a-fA-F]{${QRL_ADDRESS_HEX_LENGTH}}$`);
const textEncoder = new TextEncoder();

function checksummedHex(lowerHex: string): string {
  const hash = shake256Digest(textEncoder.encode(lowerHex), QRL_ADDRESS_BYTES);
  let result = '';
  for (let index = 0; index < lowerHex.length; index++) {
    const char = lowerHex[index] ?? '';
    if (char >= 'a' && char <= 'f') {
      const byte = hash[index >> 1] ?? 0;
      const nibble = (index & 1) === 0 ? byte >> 4 : byte & 0x0f;
      result += nibble >= 8 ? char.toUpperCase() : char;
    } else {
      result += char;
    }
  }
  return result;
}

/**
 * Validate the QRL 2.0 text form. The prefix is the network's uppercase Q.
 * A case-uniform hex body is accepted for compatibility. Mixed-case input
 * must carry the canonical SHAKE256 QIP-55 checksum.
 */
export function isCurrentQrlAddress(value: unknown): value is string {
  if (typeof value !== 'string' || !QRL_ADDRESS_RE.test(value)) return false;
  const body = value.slice(1);
  const lower = body.toLowerCase();
  if (body === lower || body === body.toUpperCase()) return true;
  return body === checksummedHex(lower);
}

/** Stable visual fingerprint for long QRL addresses. */
export function formatQrlAddressFingerprint(address: string): string {
  if (!/^Q(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{128})$/.test(address)) return address;

  const body = address.slice(1);
  const segmentLength = 8;
  if (body.length < segmentLength * 3) return address;

  const middleStart = Math.floor((body.length - segmentLength) / 2);
  return [
    `Q${body.slice(0, segmentLength)}`,
    body.slice(middleStart, middleStart + segmentLength),
    body.slice(-segmentLength),
  ].join('...');
}

/** Format exactly 64 address bytes as the canonical mixed-case QIP-55 form. */
export function qip55AddressFromBytes(address: Uint8Array): string {
  if (!(address instanceof Uint8Array) || address.length !== QRL_ADDRESS_BYTES) {
    throw new Error(`address must be exactly ${QRL_ADDRESS_BYTES} bytes`);
  }
  let lower = '';
  for (const byte of address) lower += byte.toString(16).padStart(2, '0');
  return `Q${checksummedHex(lower)}`;
}
