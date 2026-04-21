import { describe, it, expect } from 'vitest';
import {
  BLOB_LEN,
  CID_LEN,
  PK_LEN,
  cidFromString,
  cidToString,
  generateConnectionURI,
  parseConnectionURI,
} from '../src/utils/qrUri.js';
import { kemKeygen } from '../src/PQCrypto.js';

function randomCid(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(CID_LEN));
}

describe('qrUri v2', () => {
  describe('generateConnectionURI', () => {
    it('produces a qrlconnect:// URI with a single q parameter', async () => {
      const cid = randomCid();
      const { pk } = kemKeygen();
      const uri = await generateConnectionURI(cid, pk);
      expect(uri.startsWith('qrlconnect://?q=')).toBe(true);
      expect(uri.includes('&')).toBe(false);
    });

    it('rejects a non-16-byte cid', async () => {
      const { pk } = kemKeygen();
      await expect(generateConnectionURI(new Uint8Array(15), pk)).rejects.toThrow();
      await expect(generateConnectionURI(new Uint8Array(17), pk)).rejects.toThrow();
    });

    it('rejects a non-1184-byte pk', async () => {
      const cid = randomCid();
      await expect(generateConnectionURI(cid, new Uint8Array(PK_LEN - 1))).rejects.toThrow();
      await expect(generateConnectionURI(cid, new Uint8Array(PK_LEN + 1))).rejects.toThrow();
    });
  });

  describe('parseConnectionURI', () => {
    it('roundtrips cid and pk', async () => {
      const cid = randomCid();
      const { pk } = kemKeygen();
      const uri = await generateConnectionURI(cid, pk);
      const parsed = await parseConnectionURI(uri);
      expect(Array.from(parsed.cid)).toEqual(Array.from(cid));
      expect(Array.from(parsed.pk)).toEqual(Array.from(pk));
    });

    it('rejects legacy v1 URIs with a clear error', async () => {
      const legacy =
        'qrlconnect://?channelId=abc&pubKey=deadbeef&name=foo&url=http://x&chainId=0x0&relay=http://x';
      await expect(parseConnectionURI(legacy)).rejects.toThrow(/legacy v1 URI/);
    });

    it('rejects URIs with bad magic', async () => {
      const cid = randomCid();
      const { pk } = kemKeygen();
      const uri = await generateConnectionURI(cid, pk);
      // Flip a byte in the base45 payload to break the magic.
      const mutated = uri.slice(0, 17) + 'X' + uri.slice(18);
      await expect(parseConnectionURI(mutated)).rejects.toThrow();
    });

    it('rejects URIs missing q parameter', async () => {
      await expect(parseConnectionURI('qrlconnect://?')).rejects.toThrow();
    });

    it('rejects non-qrlconnect URIs', async () => {
      await expect(parseConnectionURI('wc:foo')).rejects.toThrow();
      await expect(parseConnectionURI('')).rejects.toThrow();
    });

    it('rejects fingerprint-mismatched blobs', async () => {
      // Build a blob with a valid magic/cid/pk but a corrupt fp suffix.
      const cid = randomCid();
      const { pk } = kemKeygen();
      const uri = await generateConnectionURI(cid, pk);
      // The last 4 bytes of the blob are the fp; base45-decoding the q param,
      // mutating them, and re-encoding is the cleanest tamper.
      const { base45Decode, base45Encode } = await import('../src/utils/base45.js');
      const q = new URL(
        uri.replace(/^qrlconnect:\/\//, 'http://x/')
      ).searchParams.get('q') as string;
      const blob = base45Decode(q);
      expect(blob.length).toBe(BLOB_LEN);
      blob[BLOB_LEN - 1] ^= 0xff;
      const mutatedQ = base45Encode(blob);
      const mutatedUri =
        'qrlconnect://?' + new URLSearchParams({ q: mutatedQ }).toString();
      await expect(parseConnectionURI(mutatedUri)).rejects.toThrow(/fingerprint/);
    });
  });

  describe('cid helpers', () => {
    it('cidToString/cidFromString roundtrip', () => {
      const cid = randomCid();
      const s = cidToString(cid);
      expect(s).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(Array.from(cidFromString(s))).toEqual(Array.from(cid));
    });
  });
});
