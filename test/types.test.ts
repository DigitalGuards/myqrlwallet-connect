import { describe, expect, it } from 'vitest';
import {
  ConnectionStatus,
  hasSigningDescriptor,
  isQrlSignedMessageResult,
  isQrlSignedResult,
  isQrlSignedTypedDataResult,
  KeyExchangeMessageType,
  MessageType,
  type QrlSignedMessageResult,
  type QrlSignedResult,
  type QrlSignedResultWithDescriptor,
  type QrlSignedTypedDataResult,
} from '../src/index.js';

describe('types/enums', () => {
  describe('ConnectionStatus', () => {
    it('should have all expected values', () => {
      expect(ConnectionStatus.DISCONNECTED).toBe('disconnected');
      expect(ConnectionStatus.CONNECTING).toBe('connecting');
      expect(ConnectionStatus.WAITING).toBe('waiting');
      expect(ConnectionStatus.KEY_EXCHANGE).toBe('key_exchange');
      expect(ConnectionStatus.CONNECTED).toBe('connected');
      expect(ConnectionStatus.RECONNECTING).toBe('reconnecting');
    });
  });

  describe('KeyExchangeMessageType', () => {
    it('should have all handshake message types', () => {
      expect(KeyExchangeMessageType.SYN).toBe('key_handshake_SYN');
      expect(KeyExchangeMessageType.SYNACK).toBe('key_handshake_SYNACK');
      expect(KeyExchangeMessageType.ACK).toBe('key_handshake_ACK');
    });
  });

  describe('MessageType', () => {
    it('should have all protocol message types', () => {
      expect(MessageType.KEY_EXCHANGE).toBe('key_exchange');
      expect(MessageType.JSONRPC).toBe('jsonrpc');
      expect(MessageType.WALLET_INFO).toBe('wallet_info');
      expect(MessageType.ORIGINATOR_INFO).toBe('originator_info');
      expect(MessageType.TERMINATE).toBe('terminate');
      expect(MessageType.PING).toBe('ping');
      expect(MessageType.READY).toBe('ready');
    });
  });
});

const baseResult: QrlSignedResult = {
  signature: `0x${'ab'.repeat(4627)}`,
  publicKey: `0x${'cd'.repeat(2592)}`,
  signer: `Q${'0'.repeat(40)}`,
  digest: `0x${'ef'.repeat(64)}`,
  schemeVersion: 'QRL-SIGN-MSG-v1',
};

describe('strict signing result guards', () => {
  it('type-narrows an unknown message response with a current descriptor', () => {
    const result: unknown = { ...baseResult, descriptor: '0x010000' };

    expect(isQrlSignedMessageResult(result)).toBe(true);
    if (!isQrlSignedMessageResult(result)) throw new Error('expected a message result');
    const messageResult: QrlSignedMessageResult = result;
    expect(messageResult.schemeVersion).toBe('QRL-SIGN-MSG-v1');

    expect(hasSigningDescriptor(result)).toBe(true);
    if (!hasSigningDescriptor(result)) throw new Error('expected a bound result');
    const narrowed: QrlSignedResultWithDescriptor = result;
    expect(narrowed.descriptor).toBe('0x010000');
  });

  it('accepts the exact legacy-compatible shape while descriptor narrowing fails closed', () => {
    const result: unknown = { ...baseResult };
    expect(isQrlSignedMessageResult(result)).toBe(true);
    expect(isQrlSignedResult(result)).toBe(true);
    expect(hasSigningDescriptor(result)).toBe(false);
  });

  it('type-narrows an exact typed-data response and enforces its scheme', () => {
    const result: unknown = {
      ...baseResult,
      descriptor: '0x010000',
      schemeVersion: 'QRL-SIGN-TYPED-v1',
      domain: { name: 'Security test' },
    };

    expect(isQrlSignedTypedDataResult(result)).toBe(true);
    if (!isQrlSignedTypedDataResult(result)) throw new Error('expected a typed-data result');
    const typedResult: QrlSignedTypedDataResult = result;
    expect(typedResult.domain).toEqual({ name: 'Security test' });
    expect(isQrlSignedResult(result)).toBe(true);
  });

  it.each([
    ['null', null],
    ['array', []],
    ['descriptor-only object', { descriptor: '0x010000' }],
    ['short signature', { ...baseResult, signature: '0xab' }],
    ['short public key', { ...baseResult, publicKey: '0xcd' }],
    ['short digest', { ...baseResult, digest: '0xef' }],
    ['lowercase address prefix', { ...baseResult, signer: `q${'0'.repeat(40)}` }],
    ['roadmap-width address', { ...baseResult, signer: `Q${'0'.repeat(128)}` }],
    ['unknown scheme', { ...baseResult, schemeVersion: 'QRL-SIGN-MSG-v2' }],
    ['extra field', { ...baseResult, displayText: 'unsigned' }],
    ['message result with domain', { ...baseResult, domain: {} }],
    ['typed scheme without domain', { ...baseResult, schemeVersion: 'QRL-SIGN-TYPED-v1' }],
    [
      'typed result with array domain',
      { ...baseResult, schemeVersion: 'QRL-SIGN-TYPED-v1', domain: [] },
    ],
  ])('rejects malformed unknown input: %s', (_label, result) => {
    expect(isQrlSignedResult(result)).toBe(false);
    expect(hasSigningDescriptor(result)).toBe(false);
  });

  it.each(['0x0100', '0x000000', '010000', undefined])(
    'rejects a missing or malformed descriptor: %s',
    (descriptor) => {
      const result: unknown =
        descriptor === undefined ? { ...baseResult } : { ...baseResult, descriptor };
      expect(hasSigningDescriptor(result)).toBe(false);
      expect(isQrlSignedMessageResult(result)).toBe(descriptor === undefined);
    }
  );

  it('returns false instead of throwing for hostile unknown objects', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('hostile proxy');
        },
      }
    );
    expect(() => isQrlSignedResult(hostile)).not.toThrow();
    expect(() => hasSigningDescriptor(hostile)).not.toThrow();
    expect(isQrlSignedResult(hostile)).toBe(false);
    expect(hasSigningDescriptor(hostile)).toBe(false);
  });
});
