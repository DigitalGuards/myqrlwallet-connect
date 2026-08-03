import { describe, expect, it } from 'vitest';
import {
  ConnectionStatus,
  hasSigningDescriptor,
  KeyExchangeMessageType,
  MessageType,
  type QrlSignedResult,
  type QrlSignedResultWithDescriptor,
} from '../src/types.js';

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
  signature: '0x00',
  publicKey: '0x00',
  signer: `Q${'0'.repeat(40)}`,
  digest: '0x00',
  schemeVersion: 'QRL-SIGN-MSG-v1',
};

describe('signing result descriptor guard', () => {
  it('narrows a current ML-DSA descriptor', () => {
    const result: QrlSignedResult = { ...baseResult, descriptor: '0x010000' };
    expect(hasSigningDescriptor(result)).toBe(true);
    if (hasSigningDescriptor(result)) {
      const narrowed: QrlSignedResultWithDescriptor = result;
      expect(narrowed.descriptor).toBe('0x010000');
    }
  });

  it.each([undefined, '0x0100', '0x000000', '010000'])(
    'rejects a missing or malformed descriptor: %s',
    (descriptor) => {
      const result: QrlSignedResult = { ...baseResult };
      if (descriptor !== undefined) result.descriptor = descriptor;
      expect(hasSigningDescriptor(result)).toBe(false);
    }
  );
});
