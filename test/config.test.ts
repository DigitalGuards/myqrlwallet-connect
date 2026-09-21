import { describe, it, expect } from 'vitest';
import { toChecksumAddress } from '@theqrl/wallet.js';
import {
  RESTRICTED_METHODS,
  UNRESTRICTED_METHODS,
  EXPLICITLY_UNSUPPORTED_METHODS,
  classifyRpcMethod,
  formatQrlAddressFingerprint,
  isCurrentQrlAddress,
  isValidJsonRpcId,
  isValidJsonRpcMethod,
  normalizeRelayUrl,
  qip55AddressFromBytes,
  MAX_JSON_RPC_ID_LENGTH,
  MAX_JSON_RPC_METHOD_LENGTH,
  QRL_ADDRESS_BYTES,
  QRL_ADDRESS_HEX_LENGTH,
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
      expect(RESTRICTED_METHODS.has('wallet_addQrlChain')).toBe(false);
      expect(RESTRICTED_METHODS.has('wallet_switchQrlChain')).toBe(true);
    });

    it('should have exactly 6 restricted methods', () => {
      expect(RESTRICTED_METHODS.size).toBe(6);
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
      expect(UNRESTRICTED_METHODS.has('qrl_getTransactionByHash')).toBe(false);
      expect(UNRESTRICTED_METHODS.has('qrl_getTransactionReceipt')).toBe(true);
    });

    it('should contain network info methods', () => {
      expect(UNRESTRICTED_METHODS.has('net_version')).toBe(true);
      expect(UNRESTRICTED_METHODS.has('net_listening')).toBe(true);
      expect(UNRESTRICTED_METHODS.has('web3_clientVersion')).toBe(false);
    });

    it('matches the hosted proxy read surface exactly', () => {
      expect([...UNRESTRICTED_METHODS]).toEqual([
        'qrl_chainId',
        'qrl_blockNumber',
        'qrl_getBalance',
        'qrl_getTransactionCount',
        'qrl_getBlockByNumber',
        'qrl_getTransactionReceipt',
        'qrl_call',
        'qrl_estimateGas',
        'qrl_gasPrice',
        'qrl_getCode',
        'qrl_getLogs',
        'qrl_accounts',
        'net_version',
        'net_listening',
      ]);
    });

    it('should not overlap with restricted methods', () => {
      for (const method of RESTRICTED_METHODS) {
        expect(UNRESTRICTED_METHODS.has(method)).toBe(false);
      }
    });
  });

  describe('RPC policy', () => {
    it('classifies methods with closed allowlists', () => {
      expect(classifyRpcMethod('qrl_sendTransaction')).toBe('restricted');
      expect(classifyRpcMethod('qrl_getBalance')).toBe('unrestricted');
      expect(classifyRpcMethod('qrl_sendRawTransaction')).toBe('unsupported');
      expect(classifyRpcMethod('qrl_signFuturePayload')).toBe('unsupported');
      expect(classifyRpcMethod('wallet_signFuturePayload')).toBe('unsupported');
    });

    it('keeps explicitly unsafe methods out of both positive allowlists', () => {
      for (const method of EXPLICITLY_UNSUPPORTED_METHODS) {
        expect(RESTRICTED_METHODS.has(method)).toBe(false);
        expect(UNRESTRICTED_METHODS.has(method)).toBe(false);
        expect(classifyRpcMethod(method)).toBe('unsupported');
      }
    });

    it('does not let consumers mutate the provider authorization policy', () => {
      const publicSnapshot = RESTRICTED_METHODS as Set<string>;
      publicSnapshot.add('qrl_sendRawTransaction');
      try {
        expect(classifyRpcMethod('qrl_sendRawTransaction')).toBe('unsupported');
      } finally {
        publicSnapshot.delete('qrl_sendRawTransaction');
      }
    });
  });

  describe('constants', () => {
    it('bounds JSON-RPC ids and method names before storage or relay use', () => {
      expect(isValidJsonRpcId('a'.repeat(MAX_JSON_RPC_ID_LENGTH))).toBe(true);
      expect(isValidJsonRpcId('')).toBe(false);
      expect(isValidJsonRpcId('a'.repeat(MAX_JSON_RPC_ID_LENGTH + 1))).toBe(false);
      expect(isValidJsonRpcId(Number.MAX_SAFE_INTEGER)).toBe(true);
      expect(isValidJsonRpcId(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
      expect(isValidJsonRpcId(Number.NaN)).toBe(false);

      expect(isValidJsonRpcMethod('qrl_getBalance')).toBe(true);
      expect(isValidJsonRpcMethod('a'.repeat(MAX_JSON_RPC_METHOD_LENGTH))).toBe(true);
      expect(isValidJsonRpcMethod('')).toBe(false);
      expect(isValidJsonRpcMethod('a'.repeat(MAX_JSON_RPC_METHOD_LENGTH + 1))).toBe(false);
      expect(isValidJsonRpcMethod('qrl method')).toBe(false);
    });

    it('requires secure canonical relay endpoints outside local development', () => {
      expect(normalizeRelayUrl('https://relay.example/')).toBe('https://relay.example');
      expect(normalizeRelayUrl('http://localhost:3000/')).toBe('http://localhost:3000');
      expect(normalizeRelayUrl('http://127.0.0.1:3000/')).toBe('http://127.0.0.1:3000');
      expect(normalizeRelayUrl('http://[::1]:3000/')).toBe('http://[::1]:3000');
      expect(() => normalizeRelayUrl('http://relay.example')).toThrow('Invalid relay URL');
      expect(() => normalizeRelayUrl('http://127.0.0.2')).toThrow('Invalid relay URL');
      expect(() => normalizeRelayUrl('https://user:secret@relay.example')).toThrow(
        'Invalid relay URL'
      );
      expect(() => normalizeRelayUrl('https://relay.example/#secret')).toThrow('Invalid relay URL');
      expect(() => normalizeRelayUrl('https://relay.example/ignored-base')).toThrow(
        'Invalid relay URL'
      );
      expect(() => normalizeRelayUrl('http://dev.localhost/ignored-base')).toThrow(
        'Invalid relay URL'
      );
    });

    it('validates the 64-byte QIP-55 address format and checksum casing', () => {
      const lower =
        'Qd5812f6cf4a0f645aa620cd57319a0ed649dd8f5519a9dde7770ae5b0e49e547985f35eb972a2a07041561aa39c65a3991478f9b1e6749e05277dcf58a9a8b72';
      const checksum =
        'Qd5812F6Cf4a0f645aa620cd57319a0Ed649dd8f5519A9dde7770ae5b0E49e547985f35eB972A2a07041561aa39c65A3991478f9B1e6749e05277dcf58A9A8B72';
      const bytes = new Uint8Array(
        lower
          .slice(1)
          .match(/../g)
          ?.map((byte) => Number.parseInt(byte, 16)) ?? []
      );

      expect(QRL_ADDRESS_BYTES).toBe(64);
      expect(QRL_ADDRESS_HEX_LENGTH).toBe(128);
      expect(isCurrentQrlAddress(lower)).toBe(true);
      expect(isCurrentQrlAddress(`Q${lower.slice(1).toUpperCase()}`)).toBe(true);
      expect(isCurrentQrlAddress(checksum)).toBe(true);
      expect(qip55AddressFromBytes(bytes)).toBe(checksum);
      expect(qip55AddressFromBytes(bytes)).toBe(toChecksumAddress(bytes));
      expect(isCurrentQrlAddress(`QD${checksum.slice(2)}`)).toBe(false);
      expect(isCurrentQrlAddress(`Q${'a'.repeat(40)}`)).toBe(false);
      expect(isCurrentQrlAddress(`Q${'a'.repeat(96)}`)).toBe(false);
      expect(isCurrentQrlAddress(`q${'a'.repeat(128)}`)).toBe(false);
      expect(isCurrentQrlAddress(`0x${'a'.repeat(128)}`)).toBe(false);
    });

    it('formats stable first, middle, and final address fingerprints', () => {
      const address =
        `QaBcDeF01${'2'.repeat(52)}` + `AbCdEf09${'4'.repeat(52)}FfEeDdCc`;
      expect(formatQrlAddressFingerprint(address)).toBe(
        'QaBcDeF01...AbCdEf09...FfEeDdCc'
      );
      const legacy = `Q11111111${'2'.repeat(8)}` + `33333333${'4'.repeat(8)}55555555`;
      expect(formatQrlAddressFingerprint(legacy)).toBe(
        'Q11111111...33333333...55555555'
      );
      expect(formatQrlAddressFingerprint('Q1234')).toBe('Q1234');
      expect(formatQrlAddressFingerprint(`Q${'1'.repeat(127)}`)).toBe(
        `Q${'1'.repeat(127)}`
      );
      expect(formatQrlAddressFingerprint(`Q${'1'.repeat(129)}`)).toBe(
        `Q${'1'.repeat(129)}`
      );
      expect(formatQrlAddressFingerprint(`q${'1'.repeat(128)}`)).toBe(
        `q${'1'.repeat(128)}`
      );
    });

    it('should have valid relay URL', () => {
      expect(DEFAULT_RELAY_URL).toBe('https://qrlwallet.com');
    });

    it('should have correct relay path', () => {
      expect(RELAY_PATH).toBe('/relay');
    });

    it('should have protocol version 3', () => {
      expect(PROTOCOL_VERSION).toBe(3);
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
