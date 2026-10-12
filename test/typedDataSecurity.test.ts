import { describe, expect, it } from 'vitest';
import {
  baseTypeName,
  computeTypedDataDigest,
  encodeField,
  encodeType,
  hashStruct,
  TYPED_DATA_LIMITS,
  typedDataSchemeVersion,
  type TypedDataPayload,
} from '../src/signing/typedData.js';

function payloadWith(fieldType: string, value: unknown): TypedDataPayload {
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
  it('rejects a 1 MB field type within 100 ms with a bounded error', () => {
    const type = 'T' + '[]'.repeat(499_999) + 'x';
    const payload = payloadWith(type, []);
    const start = performance.now();
    expect(() => computeTypedDataDigest(payload)).toThrow(
      new Error(`field type too long: ${type.slice(0, 32)}... (length 1000000)`)
    );
    expect(performance.now() - start).toBeLessThan(100);
  });

  it.each(['QRLDomain', 'Unused'])('checks field type length before traversing %s', (name) => {
    const payload = payloadWith('uint8', 1);
    payload.types[name] = [
      { name: 'name', type: 'x'.repeat(TYPED_DATA_LIMITS.maxFieldTypeLength + 1) },
    ];
    expect(() => computeTypedDataDigest(payload)).toThrow('field type too long');
  });

  it('preserves the field type length boundary', () => {
    const zeros = '0'.repeat(TYPED_DATA_LIMITS.maxFieldTypeLength - 'uint8[1]'.length);
    expect(() => computeTypedDataDigest(payloadWith(`uint8[${zeros}1]`, [1]))).not.toThrow();
    expect(() => computeTypedDataDigest(payloadWith(`uint8[${zeros}01]`, [1]))).toThrow(
      'field type too long'
    );
  });

  it('rejects legacy address fields', () => {
    expect(() => computeTypedDataDigest(payloadWith('address', `Q${'1'.repeat(40)}`))).toThrow(
      'invalid Q-address'
    );
  });

  it('encodes QIP-55 address fields under typed-data v2', () => {
    const payload = payloadWith('address', `Q${'1'.repeat(128)}`);
    expect(typedDataSchemeVersion(payload)).toBe('QRL-SIGN-TYPED-v2');
    expect(computeTypedDataDigest(payload)).toHaveLength(64);
    expect(typedDataSchemeVersion(payloadWith('uint8', 1))).toBe('QRL-SIGN-TYPED-v1');
  });

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

describe('typed data array suffixes', () => {
  it.each([
    'uint256',
    'address[]',
    'Struct[][3]',
    'bytes32[2][]',
    'string',
    '',
    '[]',
    '[123]',
    'Struct[0003][]',
    'Struct[2]x',
    'Struct[2][',
    'Struct[]][3]',
    'Struct[bad][]',
    'Struct[-1][]',
    'Struct[1.5][]',
    'Struct[\u0661][]',
    'Struct\n[]',
    'Struct[]\n',
    'Struct[]\r',
    'Struct[]\u2028',
    'Struct[]\u2029',
    '[]'.repeat(TYPED_DATA_LIMITS.maxFieldTypeLength / 2),
    '[' + '1'.repeat(TYPED_DATA_LIMITS.maxFieldTypeLength - 2) + ']',
    'T' + '[]'.repeat(TYPED_DATA_LIMITS.maxFieldTypeLength / 2 - 1) + 'x',
  ])('matches the original baseTypeName result for %j', (type) => {
    expect(baseTypeName(type)).toBe(type.replace(/(\[\d*\])+$/, ''));
  });
});

describe('typed data error previews', () => {
  it.each<[string, (input: string) => unknown]>([
    [
      'invalid struct name',
      (input) => {
        const payload = payloadWith('uint8', 1);
        payload.types[input] = [{ name: 'value', type: 'uint8' }];
        return computeTypedDataDigest(payload);
      },
    ],
    [
      'invalid field name in Payload',
      (input) => {
        const payload = payloadWith('uint8', 1);
        payload.types.Payload = [{ name: input, type: 'uint8' }];
        return computeTypedDataDigest(payload);
      },
    ],
    [
      'invalid primary type',
      (input) => computeTypedDataDigest({ ...payloadWith('uint8', 1), primaryType: input }),
    ],
    [
      'unknown field in Payload',
      (input) => computeTypedDataDigest({ ...payloadWith('uint8', 1), message: { [input]: 1 } }),
    ],
    ['invalid Q-address', (input) => computeTypedDataDigest(payloadWith('address', input))],
    ['unknown primary type', (input) => encodeType(input, payloadWith('uint8', 1).types)],
    ['unknown struct', (input) => hashStruct(input, {}, payloadWith('uint8', 1).types)],
    ['field type too long', (input) => encodeField(input, [], payloadWith('uint8', 1).types)],
  ])('bounds %s errors for 1 MB inputs', (label, reject) => {
    const input = 'x'.repeat(1_000_000);
    expect(() => reject(input)).toThrow(
      new Error(`${label}: ${'x'.repeat(32)}... (length 1000000)`)
    );
  });

  it('bounds invalid integer strings and out-of-range values', () => {
    expect(() => computeTypedDataDigest(payloadWith('uint256', 'x'.repeat(80)))).toThrow(
      new Error(`invalid uint256 string: ${'x'.repeat(32)}... (length 80)`)
    );
    expect(() => computeTypedDataDigest(payloadWith('uint256', '9'.repeat(80)))).toThrow(
      new Error(`uint256 out of range: ${'9'.repeat(32)}... (length 80)`)
    );
  });
});
