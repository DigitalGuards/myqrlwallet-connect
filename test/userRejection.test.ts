import { describe, expect, it } from 'vitest';
import { isUserRejection } from '../src/index.js';

describe('isUserRejection', () => {
  it('accepts the exact shape the provider rejects with', () => {
    const error = Object.assign(new Error('User rejected the request'), { code: 4001 });
    expect(isUserRejection(error)).toBe(true);
  });

  it('accepts a provider rejection that carries data', () => {
    const error = Object.assign(new Error('declined'), { code: 4001, data: { reason: 'x' } });
    expect(isUserRejection(error)).toBe(true);
  });

  it('accepts code 4001 on a plain object', () => {
    expect(isUserRejection({ code: 4001 })).toBe(true);
  });

  it('accepts code 4001 on info.error (ethers v6 wrapper)', () => {
    expect(isUserRejection({ info: { error: { code: 4001 } } })).toBe(true);
  });

  it('accepts code 4001 on cause', () => {
    expect(isUserRejection({ cause: { code: 4001 } })).toBe(true);
    expect(isUserRejection(new Error('wrapped', { cause: { code: 4001 } }))).toBe(true);
  });

  it('accepts the ethers ACTION_REJECTED code', () => {
    expect(isUserRejection(Object.assign(new Error('x'), { code: 'ACTION_REJECTED' }))).toBe(true);
  });

  it('rejects other codes', () => {
    expect(isUserRejection({ code: -32000, message: 'execution reverted' })).toBe(false);
    expect(isUserRejection({ code: 4100 })).toBe(false);
    expect(isUserRejection({ code: '4001' })).toBe(false);
    expect(isUserRejection({ info: { error: { code: 4100 } } })).toBe(false);
    expect(isUserRejection({ cause: { code: -32603 } })).toBe(false);
  });

  it('never matches on message text', () => {
    expect(isUserRejection(new Error('User rejected the request'))).toBe(false);
    expect(isUserRejection({ message: 'user denied transaction signature' })).toBe(false);
  });

  it('rejects non-objects and malformed nesting', () => {
    expect(isUserRejection('boom')).toBe(false);
    expect(isUserRejection('4001')).toBe(false);
    expect(isUserRejection(4001)).toBe(false);
    expect(isUserRejection(null)).toBe(false);
    expect(isUserRejection(undefined)).toBe(false);
    expect(isUserRejection({ info: null })).toBe(false);
    expect(isUserRejection({ info: { error: null } })).toBe(false);
    expect(isUserRejection({ cause: 4001 })).toBe(false);
  });
});
