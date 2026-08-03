import { describe, expect, it } from 'vitest';
import {
  BLOB_LEN,
  CAP_LEN,
  CID_LEN,
  FP_LEN,
  MAX_CONNECTION_URI_LENGTH,
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

function randomCapability(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(CAP_LEN));
}

describe('qrUri PQP3', () => {
  describe('generateConnectionURI', () => {
    it('produces a compact capability-bearing qrlconnect:// URI', async () => {
      const cid = randomCid();
      const { pk } = kemKeygen();
      const uri = await generateConnectionURI(cid, pk, randomCapability());
      expect(uri.startsWith('qrlconnect://?q=')).toBe(true);
      expect(uri.includes('&')).toBe(false);
      expect(uri.length).toBeLessThan(250);
    });

    it('rejects a non-16-byte cid', async () => {
      const { pk } = kemKeygen();
      const capability = randomCapability();
      await expect(generateConnectionURI(new Uint8Array(15), pk, capability)).rejects.toThrow();
      await expect(generateConnectionURI(new Uint8Array(17), pk, capability)).rejects.toThrow();
    });

    it('rejects an ML-KEM public key with the wrong width', async () => {
      const cid = randomCid();
      const capability = randomCapability();
      await expect(generateConnectionURI(cid, new Uint8Array(1183), capability)).rejects.toThrow(
        /public key/
      );
      await expect(computeFingerprint(cid, new Uint8Array(1185), capability)).rejects.toThrow(
        /public key/
      );
    });

    it('rejects a capability that is not exactly 32 bytes', async () => {
      const { pk } = kemKeygen();
      await expect(
        generateConnectionURI(randomCid(), pk, new Uint8Array(CAP_LEN - 1))
      ).rejects.toThrow(/capability/);
    });

    it('does not embed the public key in the URI', async () => {
      const { pk } = kemKeygen();
      const uri = await generateConnectionURI(randomCid(), pk, randomCapability());
      expect(uri.length).toBeLessThan(pk.length);
    });

    it('validates and normalizes custom relay URLs before embedding them', async () => {
      const { pk } = kemKeygen();
      const cid = randomCid();
      const capability = randomCapability();
      const local = await generateConnectionURI(cid, pk, capability, 'http://localhost:3000/');
      expect((await parseConnectionURI(local)).relayUrl).toBe('http://localhost:3000');

      await expect(
        generateConnectionURI(cid, pk, capability, 'http://relay.example')
      ).rejects.toThrow(/relay URL/);
      await expect(
        generateConnectionURI(cid, pk, capability, 'https://user:secret@relay.example')
      ).rejects.toThrow(/relay URL/);
      await expect(
        generateConnectionURI(cid, pk, capability, 'https://relay.example/#fragment')
      ).rejects.toThrow(/relay URL/);
      await expect(
        generateConnectionURI(cid, pk, capability, 'https://relay.example/ignored-base')
      ).rejects.toThrow(/relay URL/);
    });
  });

  describe('parseConnectionURI', () => {
    it('roundtrips cid, fingerprint, and capability', async () => {
      const cid = randomCid();
      const capability = randomCapability();
      const { pk } = kemKeygen();
      const uri = await generateConnectionURI(cid, pk, capability);
      const parsed = await parseConnectionURI(uri);
      expect(parsed.cid).toEqual(cid);
      expect(parsed.fp).toHaveLength(FP_LEN);
      expect(parsed.capability).toEqual(capability);

      const expectedFp = await computeFingerprint(cid, pk, capability);
      expect(fingerprintEquals(parsed.fp, expectedFp)).toBe(true);
      expect(parsed.relayUrl).toBeUndefined();
    });

    it('carries an optional relay URL', async () => {
      const { pk } = kemKeygen();
      const uri = await generateConnectionURI(
        randomCid(),
        pk,
        randomCapability(),
        'https://custom.relay/'
      );
      const parsed = await parseConnectionURI(uri);
      expect(parsed.relayUrl).toBe('https://custom.relay');
    });

    it('rejects legacy v1 URIs with a clear error', async () => {
      const legacy =
        'qrlconnect://?channelId=abc&pubKey=deadbeef&name=foo&url=http://x&chainId=0x0&relay=http://x';
      await expect(parseConnectionURI(legacy)).rejects.toThrow(/legacy v1 URI/);
    });

    it('rejects legacy PQP1 URIs with a clear error', async () => {
      const { base45Encode } = await import('../src/utils/base45.js');
      const pqp1 = new Uint8Array(1208);
      pqp1.set([0x50, 0x51, 0x50, 0x31]);
      const uri = 'qrlconnect://?' + new URLSearchParams({ q: base45Encode(pqp1) }).toString();
      await expect(parseConnectionURI(uri)).rejects.toThrow(/legacy PQP1/);
    });

    it('rejects legacy PQP2 URIs instead of falling back insecurely', async () => {
      const { base45Encode } = await import('../src/utils/base45.js');
      const pqp2 = new Uint8Array(52);
      pqp2.set([0x50, 0x51, 0x50, 0x32]);
      const uri = 'qrlconnect://?' + new URLSearchParams({ q: base45Encode(pqp2) }).toString();
      await expect(parseConnectionURI(uri)).rejects.toThrow(/legacy PQP2/);
    });

    it('rejects URIs with bad magic', async () => {
      const { pk } = kemKeygen();
      const uri = await generateConnectionURI(randomCid(), pk, randomCapability());
      const mutated = uri.slice(0, 17) + 'X' + uri.slice(18);
      await expect(parseConnectionURI(mutated)).rejects.toThrow();
    });

    it('rejects missing, oversized, and duplicate parameters before decoding', async () => {
      await expect(parseConnectionURI('qrlconnect://?')).rejects.toThrow(/missing q/);
      await expect(
        parseConnectionURI(`qrlconnect://?q=${'A'.repeat(MAX_CONNECTION_URI_LENGTH)}`)
      ).rejects.toThrow(/exceeds/);

      const { pk } = kemKeygen();
      const uri = await generateConnectionURI(randomCid(), pk, randomCapability());
      await expect(parseConnectionURI(`${uri}&q=ABC`)).rejects.toThrow(/duplicate/);
      await expect(parseConnectionURI(`${uri}&r=one&r=two`)).rejects.toThrow(/duplicate/);
    });

    it('rejects non-canonical URI components and unknown parameters', async () => {
      const { pk } = kemKeygen();
      const uri = await generateConnectionURI(randomCid(), pk, randomCapability());
      const query = uri.slice('qrlconnect://?'.length);

      await expect(parseConnectionURI(`qrlconnect://relay.example/?${query}`)).rejects.toThrow(
        /canonical/
      );
      await expect(parseConnectionURI(`qrlconnect:///?${query}`)).rejects.toThrow(/canonical/);
      await expect(parseConnectionURI(`${uri}#fragment`)).rejects.toThrow(/canonical/);
      await expect(parseConnectionURI(`${uri}&unexpected=value`)).rejects.toThrow(/unknown/);
      await expect(parseConnectionURI(uri.replace('qrlconnect:', 'QRLCONNECT:'))).rejects.toThrow();
    });

    it('rejects invalid relay overrides from untrusted QR input', async () => {
      const { pk } = kemKeygen();
      const uri = await generateConnectionURI(randomCid(), pk, randomCapability());
      await expect(
        parseConnectionURI(`${uri}&r=${encodeURIComponent('http://relay.example')}`)
      ).rejects.toThrow(/relay URL/);
      await expect(
        parseConnectionURI(`${uri}&r=${encodeURIComponent('https://relay.example/ignored-base')}`)
      ).rejects.toThrow(/relay URL/);
      await expect(parseConnectionURI(`${uri}&r=`)).rejects.toThrow(/empty relay URL/);
    });

    it('rejects non-qrlconnect URIs', async () => {
      await expect(parseConnectionURI('wc:foo')).rejects.toThrow();
      await expect(parseConnectionURI('')).rejects.toThrow();
    });

    it('has the exact 84-byte PQP3 blob layout', () => {
      expect(BLOB_LEN).toBe(4 + CID_LEN + FP_LEN + CAP_LEN);
      expect(BLOB_LEN).toBe(84);
    });
  });

  describe('computeFingerprint', () => {
    it('is deterministic and binds cid, public key, and capability', async () => {
      const cid = randomCid();
      const capability = randomCapability();
      const { pk } = kemKeygen();
      const fp = await computeFingerprint(cid, pk, capability);
      expect(fingerprintEquals(fp, await computeFingerprint(cid, pk, capability))).toBe(true);

      const cidAlt = cid.slice();
      cidAlt[0] ^= 1;
      expect(fingerprintEquals(fp, await computeFingerprint(cidAlt, pk, capability))).toBe(false);

      const { pk: pkAlt } = kemKeygen();
      expect(fingerprintEquals(fp, await computeFingerprint(cid, pkAlt, capability))).toBe(false);

      const capabilityAlt = capability.slice();
      capabilityAlt[0] ^= 1;
      expect(fingerprintEquals(fp, await computeFingerprint(cid, pk, capabilityAlt))).toBe(false);
    });

    it('matches the canonical cross-repo PQP3 fingerprint vector', async () => {
      const cid = new Uint8Array(CID_LEN).map((_, i) => i);
      const pk = new Uint8Array(1184).map((_, i) => i & 0xff);
      const capability = new Uint8Array(CAP_LEN).map((_, i) => 0xa0 + i);
      const fp = await computeFingerprint(cid, pk, capability);
      const hex = Array.from(fp, (value) => value.toString(16).padStart(2, '0')).join('');
      expect(fp).toHaveLength(FP_LEN);
      expect(hex).toBe('d5419e406f0d0defcd4d9b756bc51b22cde8650d216041b17ab328c0a9b04836');
    });
  });

  describe('cid helpers', () => {
    it('cidToString/cidFromString roundtrips', () => {
      const cid = randomCid();
      const value = cidToString(cid);
      expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(cidFromString(value)).toEqual(cid);
    });
  });
});
