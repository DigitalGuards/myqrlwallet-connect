/**
 * Cross-repo parity test. Loads the canonical fixture file (byte-identical
 * with the wallet's copy) and asserts the SDK's encoders + verifiers
 * produce the same outputs the wallet did. Any drift between the two repos
 * fails this test on next CI before a release can ship.
 */

/* eslint-disable @typescript-eslint/no-deprecated -- deprecated aliases need compatibility tests */

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
  ML_DSA_DESCRIPTOR_BYTES,
  ML_DSA_87_PUBLIC_KEY_BYTES,
  ML_DSA_87_SIGNATURE_BYTES,
  typeHash,
  verifyMessage,
  verifyMessageForSigner,
  verifyMessageSignature,
  verifyTypedData,
  verifyTypedDataForSigner,
  verifyTypedDataSignature,
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

  it('pins ML-DSA-87 wire sizes to the canonical wallet fixture', () => {
    const vector = canonical.signingVectors[0]!;
    expect(ML_DSA_DESCRIPTOR_BYTES).toBe(3);
    expect(ML_DSA_87_PUBLIC_KEY_BYTES).toBe(2592);
    expect(ML_DSA_87_SIGNATURE_BYTES).toBe(4627);
    expect(hexToBytes(vector.hexSeed.slice(0, 8))).toHaveLength(ML_DSA_DESCRIPTOR_BYTES);
    expect(hexToBytes(vector.publicKey)).toHaveLength(ML_DSA_87_PUBLIC_KEY_BYTES);
    expect(hexToBytes(vector.signature)).toHaveLength(ML_DSA_87_SIGNATURE_BYTES);
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

  it('key-only signature helpers accept the pinned wallet signatures', () => {
    for (const v of canonical.signingVectors) {
      if (v.messageHex !== undefined) {
        const params = {
          signature: v.signature,
          publicKey: v.publicKey,
          messageBytes: v.messageHex,
        };
        expect(verifyMessageSignature(params)).toBe(true);
        expect(verifyMessage(params)).toBe(true);
      } else if (v.payload) {
        const params = {
          signature: v.signature,
          publicKey: v.publicKey,
          payload: v.payload,
        };
        expect(verifyTypedDataSignature(params)).toBe(true);
        expect(verifyTypedData(params)).toBe(true);
      }
    }
  });

  it('bound verifiers accept pinned signatures only for their derived signer', () => {
    const message = canonical.signingVectors.find((v) => v.messageHex !== undefined)!;
    const typed = canonical.signingVectors.find((v) => v.payload !== undefined)!;
    const messageDescriptor = message.hexSeed.slice(0, 8);
    const typedDescriptor = hexToBytes(typed.hexSeed.slice(0, 8));

    expect(
      verifyMessageForSigner({
        expectedSigner: message.signer,
        descriptor: messageDescriptor,
        signature: message.signature,
        publicKey: message.publicKey,
        messageBytes: message.messageHex!,
      })
    ).toBe(true);
    expect(
      verifyTypedDataForSigner({
        expectedSigner: typed.signer,
        descriptor: typedDescriptor,
        signature: typed.signature,
        publicKey: typed.publicKey,
        payload: typed.payload!,
      })
    ).toBe(true);
  });

  it('bound verifiers reject a different current-format signer', () => {
    const message = canonical.signingVectors.find((v) => v.messageHex !== undefined)!;
    expect(
      verifyMessageForSigner({
        expectedSigner: `Q${'0'.repeat(40)}`,
        descriptor: message.hexSeed.slice(0, 8),
        signature: message.signature,
        publicKey: message.publicKey,
        messageBytes: message.messageHex!,
      })
    ).toBe(false);
  });

  it('bound verifiers reject a valid ML-DSA descriptor that derives another signer', () => {
    const typed = canonical.signingVectors.find((v) => v.payload !== undefined)!;
    expect(
      verifyTypedDataForSigner({
        expectedSigner: typed.signer,
        descriptor: '0x010001',
        signature: typed.signature,
        publicKey: typed.publicKey,
        payload: typed.payload!,
      })
    ).toBe(false);
  });

  it.each(['0x0100', '0x01000000', '0x000000', '010000'])(
    'bound verification rejects malformed or non-ML-DSA descriptor %s',
    (descriptor) => {
      const message = canonical.signingVectors.find((v) => v.messageHex !== undefined)!;
      expect(
        verifyMessageForSigner({
          expectedSigner: message.signer,
          descriptor,
          signature: message.signature,
          publicKey: message.publicKey,
          messageBytes: message.messageHex!,
        })
      ).toBe(false);
    }
  );

  it('bound verification rejects the roadmap-width address format', () => {
    const message = canonical.signingVectors.find((v) => v.messageHex !== undefined)!;
    expect(
      verifyMessageForSigner({
        expectedSigner: `Q${'a'.repeat(64)}`,
        descriptor: message.hexSeed.slice(0, 8),
        signature: message.signature,
        publicKey: message.publicKey,
        messageBytes: message.messageHex!,
      })
    ).toBe(false);
  });

  it('bound verification rejects malformed signer and public-key inputs', () => {
    const message = canonical.signingVectors.find((v) => v.messageHex !== undefined)!;
    const base = {
      descriptor: message.hexSeed.slice(0, 8),
      signature: message.signature,
      publicKey: message.publicKey,
      messageBytes: message.messageHex!,
    };

    expect(verifyMessageForSigner({ ...base, expectedSigner: 'Q1234' })).toBe(false);
    expect(
      verifyMessageForSigner({
        ...base,
        expectedSigner: message.signer,
        publicKey: '0x00',
      })
    ).toBe(false);
  });

  it('bound verification fails closed when a legacy response omits descriptor', () => {
    const message = canonical.signingVectors.find((v) => v.messageHex !== undefined)!;
    expect(
      verifyMessageForSigner({
        expectedSigner: message.signer,
        descriptor: undefined,
        signature: message.signature,
        publicKey: message.publicKey,
        messageBytes: message.messageHex!,
      })
    ).toBe(false);
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
