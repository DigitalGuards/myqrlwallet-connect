import { describe, it, expect } from 'vitest';
import {
  AEAD_KEY_LEN,
  DIR_DAPP_TX,
  DIR_WALLET_TX,
  ML_KEM_768_CT_LEN,
  ML_KEM_768_PK_LEN,
  ML_KEM_768_SK_LEN,
  SHARED_SECRET_LEN,
  aad,
  constantTimeEquals,
  concat,
  deriveAeadKey,
  exportRawAeadKey,
  fromBase64,
  importRawAeadKey,
  kemDecaps,
  kemEncaps,
  kemKeygen,
  nonce,
  open,
  seal,
  toBase64,
  transcriptHash,
  zeroize,
} from '../src/PQCrypto.js';

describe('PQCrypto', () => {
  describe('ML-KEM-768 roundtrip', () => {
    it('produces the canonical key and ciphertext sizes', () => {
      const { pk, sk } = kemKeygen();
      expect(pk.length).toBe(ML_KEM_768_PK_LEN);
      expect(sk.length).toBe(ML_KEM_768_SK_LEN);
      const { ct, ss } = kemEncaps(pk);
      expect(ct.length).toBe(ML_KEM_768_CT_LEN);
      expect(ss.length).toBe(SHARED_SECRET_LEN);
    });

    it('recovers the shared secret when ciphertext is intact', () => {
      const { pk, sk } = kemKeygen();
      const { ct, ss } = kemEncaps(pk);
      const ssRecovered = kemDecaps(sk, ct);
      expect(constantTimeEquals(ss, ssRecovered)).toBe(true);
    });

    it('returns a pseudo-random ss (never throws) on tampered ct - implicit rejection', () => {
      // This is a critical regression guard. ml-kem decapsulate() MUST NOT
      // throw on tamper; detection happens at the AEAD tag.
      const { pk, sk } = kemKeygen();
      const { ct } = kemEncaps(pk);
      const tampered = new Uint8Array(ct);
      tampered[0] ^= 0x01;
      expect(() => kemDecaps(sk, tampered)).not.toThrow();
      const ssBad = kemDecaps(sk, tampered);
      expect(ssBad.length).toBe(SHARED_SECRET_LEN);
    });

    it('derives distinct ss across independent encapsulations to the same pk', () => {
      const { pk } = kemKeygen();
      const a = kemEncaps(pk);
      const b = kemEncaps(pk);
      expect(constantTimeEquals(a.ss, b.ss)).toBe(false);
      expect(constantTimeEquals(a.ct, b.ct)).toBe(false);
    });
  });

  describe('transcript hash', () => {
    it('binds LABEL + cid + pk + ct into a 32-byte digest', async () => {
      const cid = new Uint8Array(16).map((_, i) => i);
      const pk = new Uint8Array(ML_KEM_768_PK_LEN).map((_, i) => i & 0xff);
      const ct = new Uint8Array(ML_KEM_768_CT_LEN).map((_, i) => (i + 1) & 0xff);
      const h = await transcriptHash(cid, pk, ct);
      expect(h.length).toBe(32);
      const h2 = await transcriptHash(cid, pk, ct);
      expect(constantTimeEquals(h, h2)).toBe(true);
    });

    it('changes when any input byte changes', async () => {
      const cid = new Uint8Array(16);
      const pk = new Uint8Array(ML_KEM_768_PK_LEN);
      const ct = new Uint8Array(ML_KEM_768_CT_LEN);
      const base = await transcriptHash(cid, pk, ct);
      const cidAlt = new Uint8Array(16);
      cidAlt[0] = 1;
      expect(constantTimeEquals(base, await transcriptHash(cidAlt, pk, ct))).toBe(false);
      const pkAlt = new Uint8Array(ML_KEM_768_PK_LEN);
      pkAlt[0] = 1;
      expect(constantTimeEquals(base, await transcriptHash(cid, pkAlt, ct))).toBe(false);
      const ctAlt = new Uint8Array(ML_KEM_768_CT_LEN);
      ctAlt[0] = 1;
      expect(constantTimeEquals(base, await transcriptHash(cid, pk, ctAlt))).toBe(false);
    });
  });

  describe('AEAD seal/open', () => {
    async function freshKey(): Promise<CryptoKey> {
      const { pk } = kemKeygen();
      const { ct, ss } = kemEncaps(pk);
      const htx = await transcriptHash(new Uint8Array(16), pk, ct);
      return deriveAeadKey(ss, htx);
    }

    it('roundtrips plaintext', async () => {
      const key = await freshKey();
      const htx = new Uint8Array(32).map((_, i) => i);
      const pt = new TextEncoder().encode('hello/pq');
      const ct = await seal(key, DIR_DAPP_TX, 0, htx, pt);
      const back = await open(key, DIR_DAPP_TX, 0, htx, ct);
      expect(new TextDecoder().decode(back)).toBe('hello/pq');
    });

    it('rejects tampered ciphertext at the AEAD tag', async () => {
      const key = await freshKey();
      const htx = new Uint8Array(32);
      const ct = await seal(key, DIR_DAPP_TX, 0, htx, new Uint8Array([1, 2, 3]));
      const tampered = new Uint8Array(ct);
      tampered[0] ^= 0x01;
      await expect(open(key, DIR_DAPP_TX, 0, htx, tampered)).rejects.toBeDefined();
    });

    it('rejects mismatched direction tag', async () => {
      const key = await freshKey();
      const htx = new Uint8Array(32);
      const ct = await seal(key, DIR_DAPP_TX, 0, htx, new Uint8Array([4, 5, 6]));
      await expect(open(key, DIR_WALLET_TX, 0, htx, ct)).rejects.toBeDefined();
    });

    it('rejects mismatched sequence number', async () => {
      const key = await freshKey();
      const htx = new Uint8Array(32);
      const ct = await seal(key, DIR_DAPP_TX, 7, htx, new Uint8Array([9]));
      await expect(open(key, DIR_DAPP_TX, 8, htx, ct)).rejects.toBeDefined();
    });

    it('rejects mismatched transcript hash (AAD)', async () => {
      const key = await freshKey();
      const htxA = new Uint8Array(32);
      const htxB = new Uint8Array(32);
      htxB[0] = 1;
      const ct = await seal(key, DIR_DAPP_TX, 0, htxA, new Uint8Array([0]));
      await expect(open(key, DIR_DAPP_TX, 0, htxB, ct)).rejects.toBeDefined();
    });
  });

  describe('nonce / aad', () => {
    it('encodes 12-byte deterministic nonce: dir (4 B BE) || seq (8 B LE)', () => {
      const n = nonce(DIR_DAPP_TX, 1);
      expect(n.length).toBe(12);
      expect(Array.from(n.slice(0, 4))).toEqual([0, 0, 0, 1]);
      const dv = new DataView(n.buffer, n.byteOffset, n.byteLength);
      expect(Number(dv.getBigUint64(4, true))).toBe(1);
    });

    it('AAD = H_tx || seq', () => {
      const htx = new Uint8Array(32).map((_, i) => i);
      const a = aad(htx, 42);
      expect(a.length).toBe(40);
      expect(constantTimeEquals(a.slice(0, 32), htx)).toBe(true);
      const dv = new DataView(a.buffer, a.byteOffset, a.byteLength);
      expect(Number(dv.getBigUint64(32, true))).toBe(42);
    });
  });

  describe('key persistence', () => {
    it('exports to 32 raw bytes and reimports identically', async () => {
      const { pk } = kemKeygen();
      const { ct, ss } = kemEncaps(pk);
      const htx = await transcriptHash(new Uint8Array(16), pk, ct);
      const k = await deriveAeadKey(ss, htx);
      const raw = await exportRawAeadKey(k);
      expect(raw.length).toBe(AEAD_KEY_LEN);
      const k2 = await importRawAeadKey(raw);
      const msg = new TextEncoder().encode('persist');
      const c = await seal(k, DIR_DAPP_TX, 0, htx, msg);
      const back = await open(k2, DIR_DAPP_TX, 0, htx, c);
      expect(new TextDecoder().decode(back)).toBe('persist');
    });
  });

  describe('base64 + concat utilities', () => {
    it('base64 roundtrips arbitrary bytes', () => {
      const bytes = new Uint8Array([0, 1, 2, 255, 128, 64]);
      expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    });
    it('concat preserves byte order', () => {
      const a = new Uint8Array([1, 2]);
      const b = new Uint8Array([3]);
      const c = new Uint8Array([4, 5, 6]);
      expect(Array.from(concat(a, b, c))).toEqual([1, 2, 3, 4, 5, 6]);
    });
  });

  describe('zeroize', () => {
    it('fills buffer with zeros', () => {
      const b = new Uint8Array([1, 2, 3]);
      zeroize(b);
      expect(Array.from(b)).toEqual([0, 0, 0]);
    });
  });

  describe('constant-time equality', () => {
    it('returns true for equal buffers', () => {
      expect(constantTimeEquals(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    });
    it('returns false for different content', () => {
      expect(constantTimeEquals(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    });
    it('returns false for different lengths', () => {
      expect(constantTimeEquals(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
    });
  });
});
