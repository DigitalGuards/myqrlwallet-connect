/**
 * Cross-repo parity test. Loads the canonical fixture file (byte-identical
 * with the wallet's copy) and asserts the SDK's encoders + verifiers
 * produce the same outputs the wallet did. Any drift between the two repos
 * fails this test on next CI before a release can ship.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bytesToHex,
  computeMessageDigest,
  computeTypedDataDigest,
  encodeType,
  hashStruct,
  hexToBytes,
  typeHash,
  verifyMessage,
  verifyTypedData,
  type TypedDataPayload,
} from '../index.js';

const here = dirname(fileURLToPath(import.meta.url));
const CANONICAL_PATH = join(here, '..', '__fixtures__', 'canonical.json');

interface MessageVector {
  label: string;
  messageHex: string;
  digestHex: string;
}
interface TypedVector {
  label: string;
  payload: TypedDataPayload;
  encodeTypeString: string;
  typeHashHex: string;
  domainHashHex: string;
  messageHashHex: string;
  digestHex: string;
}
interface SigningVector {
  label: string;
  hexSeed: string;
  messageHex?: string;
  payload?: TypedDataPayload;
  signature: string;
  publicKey: string;
  signer: string;
  digest: string;
}
interface Canonical {
  schemeVersionMsg: 'QRL-SIGN-MSG-v1';
  schemeVersionTyped: 'QRL-SIGN-TYPED-v1';
  messageVectors: MessageVector[];
  typedVectors: TypedVector[];
  signingVectors: SigningVector[];
}

describe('SDK ↔ wallet parity', () => {
  const canonical: Canonical = JSON.parse(readFileSync(CANONICAL_PATH, 'utf-8'));

  it('messageDigest matches every locked vector', () => {
    for (const v of canonical.messageVectors) {
      const got = bytesToHex(computeMessageDigest(hexToBytes(v.messageHex)));
      expect({ label: v.label, digest: got }).toEqual({ label: v.label, digest: v.digestHex });
    }
  });

  it('typedData encoder matches every locked vector', () => {
    for (const v of canonical.typedVectors) {
      expect(encodeType(v.payload.primaryType, v.payload.types)).toBe(v.encodeTypeString);
      expect(bytesToHex(typeHash(v.payload.primaryType, v.payload.types))).toBe(v.typeHashHex);
      expect(bytesToHex(hashStruct('QRLDomain', v.payload.domain, v.payload.types))).toBe(
        v.domainHashHex
      );
      expect(
        bytesToHex(hashStruct(v.payload.primaryType, v.payload.message, v.payload.types))
      ).toBe(v.messageHashHex);
      expect(bytesToHex(computeTypedDataDigest(v.payload))).toBe(v.digestHex);
    }
  });

  it('verifyMessage / verifyTypedData accept the pinned wallet signatures', () => {
    for (const v of canonical.signingVectors) {
      if (v.messageHex !== undefined) {
        expect(
          verifyMessage({
            signature: v.signature,
            publicKey: v.publicKey,
            messageBytes: v.messageHex,
          })
        ).toBe(true);
      } else if (v.payload) {
        expect(
          verifyTypedData({
            signature: v.signature,
            publicKey: v.publicKey,
            payload: v.payload,
          })
        ).toBe(true);
      }
    }
  });

  it('verifyMessage rejects tampered bytes', () => {
    const v = canonical.signingVectors.find((s) => s.messageHex !== undefined)!;
    expect(
      verifyMessage({
        signature: v.signature,
        publicKey: v.publicKey,
        messageBytes: v.messageHex + 'ff',
      })
    ).toBe(false);
  });

  it('verifyTypedData rejects tampered payload', () => {
    const v = canonical.signingVectors.find((s) => s.payload !== undefined)!;
    const tampered: TypedDataPayload = JSON.parse(JSON.stringify(v.payload));
    (tampered.message as Record<string, unknown>).issuedAt = '0';
    expect(
      verifyTypedData({
        signature: v.signature,
        publicKey: v.publicKey,
        payload: tampered,
      })
    ).toBe(false);
  });
});
