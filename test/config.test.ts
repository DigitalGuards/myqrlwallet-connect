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
      expect(RESTRICTED_METHODS.has('qrl_requestAccounts')).toBe(true);
    });

    it('should contain transaction signing methods', () => {
      expect(RESTRICTED_METHODS.has('qrl_sendTransaction')).toBe(true);
      expect(RESTRICTED_METHODS.has('qrl_signTransaction')).toBe(true);
    });

    it('should contain post-quantum signing methods (v3.0.0)', () => {
      expect(RESTRICTED_METHODS.has('qrl_signMessage')).toBe(true);
      expect(RESTRICTED_METHODS.has('qrl_signTypedData')).toBe(true);
    });

    it('should NOT contain removed Ethereum-flavored signing methods', () => {
      expect(RESTRICTED_METHODS.has('personal_sign')).toBe(false);
      expect(RESTRICTED_METHODS.has('qrl_sign')).toBe(false);
      expect(RESTRICTED_METHODS.has('qrl_signTypedData_v3')).toBe(false);
      expect(RESTRICTED_METHODS.has('qrl_signTypedData_v4')).toBe(false);
    });

    it('should contain chain management methods', () => {
      expect(RESTRICTED_METHODS.has('wallet_addQrlChain')).toBe(true);
      expect(RESTRICTED_METHODS.has('wallet_switchQrlChain')).toBe(true);
    });

    it('should have exactly 7 restricted methods', () => {
      expect(RESTRICTED_METHODS.size).toBe(7);
    });
  });

  describe('UNRESTRICTED_METHODS', () => {
    it('should contain read-only query methods', () => {
      expect(UNRESTRICTED_METHODS.has('qrl_chainId')).toBe(true);
      expect(UNRESTRICTED_METHODS.has('qrl_blockNumber')).toBe(true);
      expect(UNRESTRICTED_METHODS.has('qrl_getBalance')).toBe(true);
      expect(UNRESTRICTED_METHODS.has('qrl_call')).toBe(true);
      expect(UNRESTRICTED_METHODS.has('qrl_estimateGas')).toBe(true);
    });

    it('should contain transaction query methods', () => {
      expect(UNRESTRICTED_METHODS.has('qrl_getTransactionByHash')).toBe(true);
      expect(UNRESTRICTED_METHODS.has('qrl_getTransactionReceipt')).toBe(true);
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

    it('should have protocol version 2', () => {
      expect(PROTOCOL_VERSION).toBe(2);
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
