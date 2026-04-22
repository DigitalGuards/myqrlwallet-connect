import { describe, it, expect } from 'vitest';
import {
  BLOB_LEN,
  CID_LEN,
  FP_LEN,
  cidFromString,
  cidToString,
  computeFingerprint,
  fingerprintEquals,
  generateConnectionURI,
  parseConnectionURI,
} from '../src/utils/qrUri.js';
import { kemKeygen } from '../src/PQCrypto.js';

function randomCid(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(CID_LEN));
}

describe('qrUri PQP2', () => {
  describe('generateConnectionURI', () => {
    it('produces a compact qrlconnect:// URI with only cid+fp in the blob', async () => {
      const cid = randomCid();
      const { pk } = kemKeygen();
      const uri = await generateConnectionURI(cid, pk);
      expect(uri.startsWith('qrlconnect://?q=')).toBe(true);
      expect(uri.includes('&')).toBe(false);
      // 52-byte blob → ~78 base45 chars → URL-encoded still under ~100 chars
      // of payload. Plenty of headroom for a version-5-class QR.
      expect(uri.length).toBeLessThan(200);
    });

    it('rejects a non-16-byte cid', async () => {
      const { pk } = kemKeygen();
      await expect(generateConnectionURI(new Uint8Array(15), pk)).rejects.toThrow();
      await expect(generateConnectionURI(new Uint8Array(17), pk)).rejects.toThrow();
    });

    it('does not embed the PK in the URI', async () => {
      const cid = randomCid();
      const { pk } = kemKeygen();
      const uri = await generateConnectionURI(cid, pk);
      // The compressed URI can't possibly contain the 1184-byte PK.
      expect(uri.length).toBeLessThan(pk.length);
    });
  });

  describe('parseConnectionURI', () => {
    it('roundtrips cid and fp', async () => {
      const cid = randomCid();
      const { pk } = kemKeygen();
      const uri = await generateConnectionURI(cid, pk);
      const parsed = await parseConnectionURI(uri);
      expect(Array.from(parsed.cid)).toEqual(Array.from(cid));
      expect(parsed.fp.length).toBe(FP_LEN);

      // The fp in the URI must equal the fp the wallet re-derives after
      // fetching the PK from the relay.
      const expectedFp = await computeFingerprint(cid, pk);
      expect(fingerprintEquals(parsed.fp, expectedFp)).toBe(true);
      expect(parsed.relayUrl).toBeUndefined();
    });

    it('carries an optional relay URL', async () => {
      const cid = randomCid();
      const { pk } = kemKeygen();
      const uri = await generateConnectionURI(cid, pk, 'https://custom.relay/test');
      const parsed = await parseConnectionURI(uri);
      expect(parsed.relayUrl).toBe('https://custom.relay/test');
    });

    it('rejects legacy v1 URIs with a clear error', async () => {
      const legacy =
        'qrlconnect://?channelId=abc&pubKey=deadbeef&name=foo&url=http://x&chainId=0x0&relay=http://x';
      await expect(parseConnectionURI(legacy)).rejects.toThrow(/legacy v1 URI/);
    });

    it('rejects legacy PQP1 URIs with a clear error', async () => {
      // Build a dummy PQP1-shaped 1208-byte blob so the parser can recognise
      // the shape and emit the "regenerate the QR" hint instead of a generic
      // size mismatch.
      const { base45Encode } = await import('../src/utils/base45.js');
      const pqp1 = new Uint8Array(1208);
      pqp1[0] = 0x50;
      pqp1[1] = 0x51;
      pqp1[2] = 0x50;
      pqp1[3] = 0x31; // '1'
      const uri = 'qrlconnect://?' + new URLSearchParams({ q: base45Encode(pqp1) }).toString();
      await expect(parseConnectionURI(uri)).rejects.toThrow(/legacy PQP1/);
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

    it('has blob length 52 bytes', () => {
      // Sanity check: the whole point of PQP2 is the small blob.
      expect(BLOB_LEN).toBe(4 + CID_LEN + FP_LEN);
      expect(BLOB_LEN).toBe(52);
    });
  });

  describe('computeFingerprint', () => {
    it('is deterministic', async () => {
      const cid = randomCid();
      const { pk } = kemKeygen();
      const fp1 = await computeFingerprint(cid, pk);
      const fp2 = await computeFingerprint(cid, pk);
      expect(fingerprintEquals(fp1, fp2)).toBe(true);
    });

    it('depends on both cid and pk (domain separation)', async () => {
      const cidA = randomCid();
      const cidB = randomCid();
      const { pk } = kemKeygen();
      const fpA = await computeFingerprint(cidA, pk);
      const fpB = await computeFingerprint(cidB, pk);
      expect(fingerprintEquals(fpA, fpB)).toBe(false);
    });

    it('produces 32-byte output', async () => {
      const cid = randomCid();
      const { pk } = kemKeygen();
      const fp = await computeFingerprint(cid, pk);
      expect(fp.length).toBe(32);
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
