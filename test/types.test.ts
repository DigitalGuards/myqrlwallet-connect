import { describe, it, expect } from 'vitest';
import {
  ConnectionStatus,
  KeyExchangeMessageType,
  MessageType,
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
