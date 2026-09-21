import { describe, expect, it } from 'vitest';
import {
  canonicalChainId,
  makeTypedRejectionPayload,
  parseQuanta,
  QRL_ZERO_ADDRESS,
} from './demo-utils.js';

describe('example transaction values', () => {
  it.each([
    ['0', 0n],
    ['0.000000000000000001', 1n],
    ['0.123456789012345678', 123456789012345678n],
    ['9007199254740993', 9007199254740993000000000000000000n],
  ])('preserves the exact amount %s', (text, expected) => {
    expect(parseQuanta(text)).toBe(expected);
  });
  it.each([
    '-1',
    '-0',
    '1e18',
    'Infinity',
    'NaN',
    '0.1234567890123456789',
    '',
    '1.',
    '.1',
    '9'.repeat(100),
  ])('rejects invalid amount %s', (value) => {
    expect(() => parseQuanta(value)).toThrow();
  });
});

describe('example network and typed-data probe', () => {
  it('uses full-width addresses and the connected chain', () => {
    const account = `Q${'a'.repeat(128)}`;
    const payload = makeTypedRejectionPayload(account, '0x301825', 0);
    expect(payload.domain.chainId).toBe('3151909');
    expect(payload.domain.verifyingContract).toBe(QRL_ZERO_ADDRESS);
    expect(QRL_ZERO_ADDRESS).toHaveLength(129);
    expect(payload.message.account).toBe(account);
    expect(makeTypedRejectionPayload(account, '0x2a', 0).domain.chainId).toBe('42');
  });
  it('uses the private v3 example profile before connecting', () => {
    expect(makeTypedRejectionPayload(null, null, 0).domain.chainId).toBe('3151909');
  });
  it.each(['0x0', '1337', '', null, '0x' + 'f'.repeat(65)])(
    'rejects an invalid wallet chain %s',
    (value) => {
      expect(() => canonicalChainId(value)).toThrow();
    }
  );
});
