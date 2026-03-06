import { describe, it, expect } from 'vitest';
import {
  RESTRICTED_METHODS,
  UNRESTRICTED_METHODS,
  DEFAULT_RELAY_URL,
  RELAY_PATH,
  PROTOCOL_VERSION,
  SESSION_TTL_MS,
  REQUEST_TIMEOUT_MS,
  WALLET_UNRESPONSIVE_MS,
} from '../src/config.js';

describe('config', () => {
  describe('RESTRICTED_METHODS', () => {
    it('should contain account request methods', () => {
      expect(RESTRICTED_METHODS.has('zond_requestAccounts')).toBe(true);
    });

    it('should contain transaction signing methods', () => {
      expect(RESTRICTED_METHODS.has('zond_sendTransaction')).toBe(true);
      expect(RESTRICTED_METHODS.has('zond_signTransaction')).toBe(true);
      expect(RESTRICTED_METHODS.has('zond_sign')).toBe(true);
      expect(RESTRICTED_METHODS.has('personal_sign')).toBe(true);
    });

    it('should contain typed data signing methods', () => {
      expect(RESTRICTED_METHODS.has('zond_signTypedData')).toBe(true);
      expect(RESTRICTED_METHODS.has('zond_signTypedData_v3')).toBe(true);
      expect(RESTRICTED_METHODS.has('zond_signTypedData_v4')).toBe(true);
    });

    it('should contain chain management methods', () => {
      expect(RESTRICTED_METHODS.has('wallet_addZondChain')).toBe(true);
      expect(RESTRICTED_METHODS.has('wallet_switchZondChain')).toBe(true);
    });

    it('should have exactly 10 restricted methods', () => {
      expect(RESTRICTED_METHODS.size).toBe(10);
    });
  });

  describe('UNRESTRICTED_METHODS', () => {
    it('should contain read-only query methods', () => {
      expect(UNRESTRICTED_METHODS.has('zond_chainId')).toBe(true);
      expect(UNRESTRICTED_METHODS.has('zond_blockNumber')).toBe(true);
      expect(UNRESTRICTED_METHODS.has('zond_getBalance')).toBe(true);
      expect(UNRESTRICTED_METHODS.has('zond_call')).toBe(true);
      expect(UNRESTRICTED_METHODS.has('zond_estimateGas')).toBe(true);
    });

    it('should contain transaction query methods', () => {
      expect(UNRESTRICTED_METHODS.has('zond_getTransactionByHash')).toBe(true);
      expect(UNRESTRICTED_METHODS.has('zond_getTransactionReceipt')).toBe(true);
    });

    it('should contain network info methods', () => {
      expect(UNRESTRICTED_METHODS.has('net_version')).toBe(true);
      expect(UNRESTRICTED_METHODS.has('net_listening')).toBe(true);
      expect(UNRESTRICTED_METHODS.has('web3_clientVersion')).toBe(true);
    });

    it('should not overlap with restricted methods', () => {
      for (const method of RESTRICTED_METHODS) {
        expect(UNRESTRICTED_METHODS.has(method)).toBe(false);
      }
    });
  });

  describe('constants', () => {
    it('should have valid relay URL', () => {
      expect(DEFAULT_RELAY_URL).toBe('https://qrlwallet.com');
    });

    it('should have correct relay path', () => {
      expect(RELAY_PATH).toBe('/relay');
    });

    it('should have protocol version 1', () => {
      expect(PROTOCOL_VERSION).toBe(1);
    });

    it('should have 7-day session TTL', () => {
      expect(SESSION_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it('should have 5-minute request timeout', () => {
      expect(REQUEST_TIMEOUT_MS).toBe(5 * 60 * 1000);
    });

    it('should have 30-second wallet unresponsive timeout', () => {
      expect(WALLET_UNRESPONSIVE_MS).toBe(30 * 1000);
    });
  });
});
