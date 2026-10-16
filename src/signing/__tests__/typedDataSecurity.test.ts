import { describe, expect, it, assert } from 'vitest';

import { computeTypedDataDigest } from '../index.js';

function validPayload(): {
  types: {
    Payload: { name: string; type: string; label?: string }[];
    [name: string]: { name: string; type: string }[];
  };
  primaryType: string;
  domain: { name: string };
  message: { value: number };
} {
  return {
    types: {
      QRLDomain: [{ name: 'name', type: 'string' }],
      Payload: [{ name: 'value', type: 'uint8' }],
    },
    primaryType: 'Payload',
    domain: { name: 'Security test' },
    message: { value: 1 },
  };
}

describe('typed-data ambiguity rejection', () => {
  it('rejects unknown top-level payload fields', () => {
    expect(() =>
      computeTypedDataDigest({ ...validPayload(), extra: 'displayed-but-unsigned' })
    ).toThrow(/unknown top-level fields/);
  });

  it('rejects unknown keys on a typed field declaration', () => {
    const payload = validPayload();
    const types = payload.types;
    assert.isDefined(types.Payload[0]);
    types.Payload[0].label = 'display-only';

    expect(() => computeTypedDataDigest(payload)).toThrow(/struct map/);
  });

  it.each(['string', 'address', 'uint256', 'bytes32'])(
    'rejects a struct that shadows atomic type %s',
    (reservedName) => {
      const payload = validPayload();
      const types = payload.types;
      assert.isDefined(types.Payload[0]);
      types.Payload[0].type = reservedName;
      types[reservedName] = [{ name: 'hidden', type: 'uint8' }];

      expect(() => computeTypedDataDigest(payload)).toThrow(/reserved by an atomic type/);
    }
  );

  it('rejects QRLDomain as the primary message type', () => {
    expect(() =>
      computeTypedDataDigest({
        types: { QRLDomain: [{ name: 'name', type: 'string' }] },
        primaryType: 'QRLDomain',
        domain: { name: 'Security test' },
        message: { name: 'Security test' },
      })
    ).toThrow(/cannot be the primary type/);
  });
});
