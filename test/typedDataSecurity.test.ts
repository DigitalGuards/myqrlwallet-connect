import { describe, expect, it } from 'vitest';
import { computeTypedDataDigest, TYPED_DATA_LIMITS } from '../src/signing/typedData.js';

function payloadWith(fieldType: string, value: unknown): unknown {
  return {
    types: {
      QRLDomain: [{ name: 'name', type: 'string' }],
      Payload: [{ name: 'value', type: fieldType }],
    },
    primaryType: 'Payload',
    domain: { name: 'Security test' },
    message: { value },
  };
}

describe('typed data resource and nesting limits', () => {
  it('rejects dynamic arrays above the deterministic item cap', () => {
    const values = new Array(TYPED_DATA_LIMITS.maxArrayLength + 1).fill(1);
    expect(() => computeTypedDataDigest(payloadWith('uint8[]', values))).toThrow(
      'exceeds length limit'
    );
  });

  it('rejects oversized fixed arrays at the type boundary', () => {
    const type = `uint8[${TYPED_DATA_LIMITS.maxArrayLength + 1}]`;
    expect(() => computeTypedDataDigest(payloadWith(type, []))).toThrow('invalid array size');
  });

  it('rejects deeply nested custom struct graphs before recursive hashing', () => {
    const types: Record<string, { name: string; type: string }[]> = {
      QRLDomain: [{ name: 'name', type: 'string' }],
    };
    let message: Record<string, unknown> = { value: 7 };
    for (let i = TYPED_DATA_LIMITS.maxTypeGraphDepth + 2; i >= 0; i--) {
      const name = `Node${i}`;
      const next = `Node${i + 1}`;
      types[name] = [
        { name: 'value', type: i > TYPED_DATA_LIMITS.maxTypeGraphDepth + 1 ? 'uint8' : next },
      ];
      if (i <= TYPED_DATA_LIMITS.maxTypeGraphDepth + 1) message = { value: message };
    }

    expect(() =>
      computeTypedDataDigest({
        types,
        primaryType: 'Node0',
        domain: { name: 'Security test' },
        message,
      })
    ).toThrow('type graph nesting too deep');
  });

  it('rejects oversized dynamic strings before hashing', () => {
    const text = 'a'.repeat(TYPED_DATA_LIMITS.maxDynamicBytes + 1);
    expect(() => computeTypedDataDigest(payloadWith('string', text))).toThrow(
      'string field exceeds typed data byte limit'
    );
  });

  it('rejects prototype-sensitive field identifiers', () => {
    expect(() =>
      computeTypedDataDigest({
        types: {
          QRLDomain: [{ name: 'name', type: 'string' }],
          Payload: [{ name: 'constructor', type: 'string' }],
        },
        primaryType: 'Payload',
        domain: { name: 'Security test' },
        message: { constructor: 'hidden' },
      })
    ).toThrow('invalid field name');
  });

  it('accepts bounded nested structs and arrays', () => {
    expect(() =>
      computeTypedDataDigest({
        types: {
          QRLDomain: [{ name: 'name', type: 'string' }],
          Payload: [{ name: 'items', type: 'Item[]' }],
          Item: [{ name: 'value', type: 'uint16' }],
        },
        primaryType: 'Payload',
        domain: { name: 'Security test' },
        message: { items: [{ value: 1 }, { value: 2 }] },
      })
    ).not.toThrow();
  });
});
