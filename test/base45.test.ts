import { describe, it, expect } from 'vitest';
import { base45Decode, base45Encode } from '../src/utils/base45.js';

describe('base45 (RFC 9285)', () => {
  it('encodes the RFC 9285 vector "AB" to "BB8"', () => {
    const enc = base45Encode(new TextEncoder().encode('AB'));
    expect(enc).toBe('BB8');
  });

  it('encodes "Hello!!" to "%69 VD92EX0"', () => {
    // From RFC 9285 §4.4 — canonical test vector.
    const enc = base45Encode(new TextEncoder().encode('Hello!!'));
    expect(enc).toBe('%69 VD92EX0');
  });

  it('decodes "BB8" back to "AB"', () => {
    const dec = base45Decode('BB8');
    expect(new TextDecoder().decode(dec)).toBe('AB');
  });

  it('roundtrips random byte arrays up to 1208 bytes', () => {
    const sizes = [0, 1, 2, 3, 16, 17, 1024, 1207, 1208];
    for (const n of sizes) {
      const input = globalThis.crypto.getRandomValues(new Uint8Array(n));
      const out = base45Decode(base45Encode(input));
      expect(Array.from(out)).toEqual(Array.from(input));
    }
  });

  it('rejects invalid characters', () => {
    expect(() => base45Decode('!!!')).toThrow();
  });

  it('rejects invalid length (tail of 1)', () => {
    expect(() => base45Decode('BBBB')).toThrow();
  });
});
