/**
 * Known-answer self-check for ML-KEM-768.
 *
 * We don't pin raw pq-crystals KAT vectors here because the upstream format
 * uses a seeded NIST DRBG that noble doesn't expose. What we pin instead is:
 *
 *   1. The published algorithm sizes (pk=1184, sk=2400, ct=1088, ss=32).
 *   2. The self-consistent roundtrip (encap → decap recovers the same ss).
 *   3. Implicit rejection on tampered ciphertext.
 *   4. Deterministic behaviour from a fixed 64-byte seed input to encapsulate.
 *
 * These together catch library substitutions and accidental parameter-set
 * swaps (e.g. a refactor that leaves us on ML-KEM-512 or ML-KEM-1024).
 */

import { describe, it, expect } from 'vitest';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import {
  ML_KEM_768_CT_LEN,
  ML_KEM_768_PK_LEN,
  ML_KEM_768_SK_LEN,
  SHARED_SECRET_LEN,
  constantTimeEquals,
} from '../src/PQCrypto.js';

describe('ML-KEM-768 KAT self-check', () => {
  it('pins canonical algorithm sizes', () => {
    expect(ml_kem768.lengths?.publicKey).toBe(ML_KEM_768_PK_LEN);
    expect(ml_kem768.lengths?.secretKey).toBe(ML_KEM_768_SK_LEN);
    expect(ml_kem768.lengths?.cipherText).toBe(ML_KEM_768_CT_LEN);
  });

  it('is deterministic given a 64-byte keygen seed and a 32-byte encap seed', () => {
    const keygenSeed = new Uint8Array(64).map((_, i) => i);
    const a = ml_kem768.keygen(keygenSeed);
    const b = ml_kem768.keygen(keygenSeed);
    expect(constantTimeEquals(a.publicKey, b.publicKey)).toBe(true);
    expect(constantTimeEquals(a.secretKey, b.secretKey)).toBe(true);

    const encapSeed = new Uint8Array(32).map((_, i) => 0x80 + i);
    const r1 = ml_kem768.encapsulate(a.publicKey, encapSeed);
    const r2 = ml_kem768.encapsulate(a.publicKey, encapSeed);
    expect(constantTimeEquals(r1.cipherText, r2.cipherText)).toBe(true);
    expect(constantTimeEquals(r1.sharedSecret, r2.sharedSecret)).toBe(true);
    expect(r1.sharedSecret.length).toBe(SHARED_SECRET_LEN);

    const ssBack = ml_kem768.decapsulate(r1.cipherText, a.secretKey);
    expect(constantTimeEquals(r1.sharedSecret, ssBack)).toBe(true);
  });

  it('implicit-rejection: decapsulate never throws on tampered ct', () => {
    const { publicKey, secretKey } = ml_kem768.keygen();
    const { cipherText } = ml_kem768.encapsulate(publicKey);
    const tampered = new Uint8Array(cipherText);
    tampered[0] ^= 0xff;
    expect(() => ml_kem768.decapsulate(tampered, secretKey)).not.toThrow();
    expect(ml_kem768.decapsulate(tampered, secretKey).length).toBe(SHARED_SECRET_LEN);
  });
});
