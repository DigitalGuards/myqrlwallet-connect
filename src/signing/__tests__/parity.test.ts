/**
 * Cross-repo parity test. Loads the canonical fixture file (byte-identical
 * with the wallet's copy) and asserts the SDK's encoders + verifiers
 * produce the same outputs the wallet did. Any drift between the two repos
 * fails this test on next CI before a release can ship.
 */

import { describe, it, expect, assert } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCurrentQrlAddress } from '../../config.js';
import {
  verifyMessage as verifyMessageFromSdk,
  verifyTypedData as verifyTypedDataFromSdk,
} from '../../index.js';
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
  SCHEME_VERSION_TYPED,
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
  payload: TypedDataPayload;
  encodeTypeString: string;
  typeHashHex: string;
  domainHashHex: string;
}
interface SigningVector {
  hexSeed: string;
  messageHex?: string;
  payload?: TypedDataPayload;
  signature: string;
  publicKey: string;
  signer: string;
}
interface Canonical {
  messageVectors: MessageVector[];
  typedVectors: TypedVector[];
  signingVectors: SigningVector[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isTypedDataPayload(value: unknown): value is TypedDataPayload {
  return (
    isRecord(value) &&
    typeof value.primaryType === 'string' &&
    isRecord(value.types) &&
    Object.values(value.types).every(
      (fields: unknown) =>
        Array.isArray(fields) &&
        fields.every(
          (field: unknown) =>
            isRecord(field) && typeof field.name === 'string' && typeof field.type === 'string'
        )
    ) &&
    isRecord(value.domain) &&
    isRecord(value.message)
  );
}

function isCanonical(value: unknown): value is Canonical {
  return (
    isRecord(value) &&
    Array.isArray(value.messageVectors) &&
    value.messageVectors.every(
      (v: unknown) =>
        isRecord(v) &&
        typeof v.label === 'string' &&
        typeof v.messageHex === 'string' &&
        typeof v.digestHex === 'string'
    ) &&
    Array.isArray(value.typedVectors) &&
    value.typedVectors.every(
      (v: unknown) =>
        isRecord(v) &&
        isTypedDataPayload(v.payload) &&
        typeof v.encodeTypeString === 'string' &&
        typeof v.typeHashHex === 'string' &&
        typeof v.domainHashHex === 'string'
    ) &&
    Array.isArray(value.signingVectors) &&
    value.signingVectors.every(
      (v: unknown) =>
        isRecord(v) &&
        typeof v.hexSeed === 'string' &&
        (v.messageHex === undefined || typeof v.messageHex === 'string') &&
        (v.payload === undefined || isTypedDataPayload(v.payload)) &&
        typeof v.signature === 'string' &&
        typeof v.publicKey === 'string' &&
        typeof v.signer === 'string'
    )
  );
}

describe('SDK ↔ wallet parity', () => {
  const canonical: unknown = JSON.parse(readFileSync(CANONICAL_PATH, 'utf-8'));
  assert(isCanonical(canonical));

  it('messageDigest matches every locked vector', () => {
    for (const v of canonical.messageVectors) {
      const got = bytesToHex(computeMessageDigest(hexToBytes(v.messageHex)));
      expect({ label: v.label, digest: got }).toEqual({ label: v.label, digest: v.digestHex });
    }
  });

  it('pins ML-DSA-87 wire sizes to the canonical wallet fixture', () => {
    const vector = canonical.signingVectors[0];
    assert.isDefined(vector);
    expect(ML_DSA_DESCRIPTOR_BYTES).toBe(3);
    expect(ML_DSA_87_PUBLIC_KEY_BYTES).toBe(2592);
    expect(ML_DSA_87_SIGNATURE_BYTES).toBe(4627);
    expect(hexToBytes(vector.hexSeed.slice(0, 8))).toHaveLength(ML_DSA_DESCRIPTOR_BYTES);
    expect(hexToBytes(vector.publicKey)).toHaveLength(ML_DSA_87_PUBLIC_KEY_BYTES);
    expect(hexToBytes(vector.signature)).toHaveLength(ML_DSA_87_SIGNATURE_BYTES);
    expect(vector.signer).toHaveLength(129);
    expect(isCurrentQrlAddress(vector.signer)).toBe(true);
  });

  it('preserves legacy type hashes while rejecting legacy typed addresses', () => {
    for (const v of canonical.typedVectors) {
      expect(encodeType(v.payload.primaryType, v.payload.types)).toBe(v.encodeTypeString);
      expect(bytesToHex(typeHash(v.payload.primaryType, v.payload.types))).toBe(v.typeHashHex);
      // These vectors are v1 history; their address fields would select v2.
      expect(
        bytesToHex(hashStruct('QRLDomain', v.payload.domain, v.payload.types, SCHEME_VERSION_TYPED))
      ).toBe(v.domainHashHex);
      expect(() =>
        bytesToHex(
          hashStruct(
            v.payload.primaryType,
            v.payload.message,
            v.payload.types,
            SCHEME_VERSION_TYPED
          )
        )
      ).toThrow(/invalid Q-address/);
      expect(() => computeTypedDataDigest(v.payload)).toThrow(/invalid Q-address/);
    }
  });

  it('key-only helpers verify messages and reject legacy typed addresses', () => {
    for (const v of canonical.signingVectors) {
      if (v.messageHex !== undefined) {
        const params = {
          signature: v.signature,
          publicKey: v.publicKey,
          messageBytes: v.messageHex,
        };
        expect(verifyMessageSignature(params)).toBe(true);
        expect(verifyMessage(params)).toBe(true);
        expect(verifyMessageFromSdk(params)).toBe(true);
      } else if (v.payload) {
        const params = {
          signature: v.signature,
          publicKey: v.publicKey,
          payload: v.payload,
        };
        expect(verifyTypedDataSignature(params)).toBe(false);
        expect(verifyTypedData(params)).toBe(false);
        expect(verifyTypedDataFromSdk(params)).toBe(false);
      }
    }
  });

  it('bound verifiers accept current messages and reject legacy typed addresses', () => {
    const message = canonical.signingVectors.find((v) => v.messageHex !== undefined);
    assert.isDefined(message);
    assert.isDefined(message.messageHex);
    const typed = canonical.signingVectors.find((v) => v.payload !== undefined);
    assert.isDefined(typed);
    assert.isDefined(typed.payload);
    const messageDescriptor = message.hexSeed.slice(0, 8);
    const typedDescriptor = hexToBytes(typed.hexSeed.slice(0, 8));

    expect(
      verifyMessageForSigner({
        expectedSigner: message.signer,
        descriptor: messageDescriptor,
        signature: message.signature,
        publicKey: message.publicKey,
        messageBytes: message.messageHex,
      })
    ).toBe(true);
    expect(
      verifyTypedDataForSigner({
        expectedSigner: typed.signer,
        descriptor: typedDescriptor,
        signature: typed.signature,
        publicKey: typed.publicKey,
        payload: typed.payload,
      })
    ).toBe(false);
  });

  it('bound verifiers reject a different current-format signer', () => {
    const message = canonical.signingVectors.find((v) => v.messageHex !== undefined);
    assert.isDefined(message);
    assert.isDefined(message.messageHex);
    expect(
      verifyMessageForSigner({
        expectedSigner: `Q${'0'.repeat(128)}`,
        descriptor: message.hexSeed.slice(0, 8),
        signature: message.signature,
        publicKey: message.publicKey,
        messageBytes: message.messageHex,
      })
    ).toBe(false);
  });

  it('bound verifiers reject a valid ML-DSA descriptor that derives another signer', () => {
    const typed = canonical.signingVectors.find((v) => v.payload !== undefined);
    assert.isDefined(typed);
    assert.isDefined(typed.payload);
    expect(
      verifyTypedDataForSigner({
        expectedSigner: typed.signer,
        descriptor: '0x010001',
        signature: typed.signature,
        publicKey: typed.publicKey,
        payload: typed.payload,
      })
    ).toBe(false);
  });

  it.each(['0x0100', '0x01000000', '0x000000', '010000'])(
    'bound verification rejects malformed or non-ML-DSA descriptor %s',
    (descriptor) => {
      const message = canonical.signingVectors.find((v) => v.messageHex !== undefined);
      assert.isDefined(message);
      assert.isDefined(message.messageHex);
      expect(
        verifyMessageForSigner({
          expectedSigner: message.signer,
          descriptor,
          signature: message.signature,
          publicKey: message.publicKey,
          messageBytes: message.messageHex,
        })
      ).toBe(false);
    }
  );

  it('bound verification rejects the legacy address format', () => {
    const message = canonical.signingVectors.find((v) => v.messageHex !== undefined);
    assert.isDefined(message);
    assert.isDefined(message.messageHex);
    expect(
      verifyMessageForSigner({
        expectedSigner: `Q${'a'.repeat(40)}`,
        descriptor: message.hexSeed.slice(0, 8),
        signature: message.signature,
        publicKey: message.publicKey,
        messageBytes: message.messageHex,
      })
    ).toBe(false);
  });

  it('bound verification rejects malformed signer and public-key inputs', () => {
    const message = canonical.signingVectors.find((v) => v.messageHex !== undefined);
    assert.isDefined(message);
    assert.isDefined(message.messageHex);
    const base = {
      descriptor: message.hexSeed.slice(0, 8),
      signature: message.signature,
      publicKey: message.publicKey,
      messageBytes: message.messageHex,
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
    const message = canonical.signingVectors.find((v) => v.messageHex !== undefined);
    assert.isDefined(message);
    assert.isDefined(message.messageHex);
    expect(
      verifyMessageForSigner({
        expectedSigner: message.signer,
        descriptor: undefined,
        signature: message.signature,
        publicKey: message.publicKey,
        messageBytes: message.messageHex,
      })
    ).toBe(false);
  });

  it('verifyMessage and verifyMessageSignature reject tampered bytes', () => {
    const v = canonical.signingVectors.find((s) => s.messageHex !== undefined);
    assert.isDefined(v);
    assert.isDefined(v.messageHex);
    const params = {
      signature: v.signature,
      publicKey: v.publicKey,
      messageBytes: v.messageHex + 'ff',
    };
    expect(verifyMessageSignature(params)).toBe(false);
    expect(verifyMessage(params)).toBe(false);
    expect(verifyMessageFromSdk(params)).toBe(false);
  });

  it('verifyTypedData and verifyTypedDataSignature reject tampered payload', () => {
    const v = canonical.signingVectors.find((s) => s.payload !== undefined);
    assert.isDefined(v);
    assert.isDefined(v.payload);
    const tampered: unknown = JSON.parse(JSON.stringify(v.payload));
    assert(isTypedDataPayload(tampered));
    tampered.message.issuedAt = '0';
    const params = {
      signature: v.signature,
      publicKey: v.publicKey,
      payload: tampered,
    };
    expect(verifyTypedDataSignature(params)).toBe(false);
    expect(verifyTypedData(params)).toBe(false);
    expect(verifyTypedDataFromSdk(params)).toBe(false);
  });
});
