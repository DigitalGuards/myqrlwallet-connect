import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import EventEmitter from 'eventemitter3';
import { ConnectionStatus } from '../src/types.js';

// Track all mock instances
let latestMockCM: MockConnectionManager;

class MockConnectionManager extends EventEmitter {
  status = ConnectionStatus.DISCONNECTED;
  accounts: string[] = [];
  chainId = '0x0';
  channelId = 'mock-channel';

  constructor() {
    super();
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    latestMockCM = this;
  }

  getStatus() { return this.status; }
  getAccounts() { return this.accounts; }
  getChainId() { return this.chainId; }
  getChannelId() { return this.channelId; }
  getConnectionURI = vi.fn().mockResolvedValue('qrlconnect://?channelId=mock');
  sendJsonRpc = vi.fn();
  reconnect = vi.fn().mockResolvedValue(false);
  disconnect = vi.fn();
}

vi.mock('../src/ConnectionManager.js', () => ({
  ConnectionManager: vi.fn().mockImplementation((...args: unknown[]) => {
    return new MockConnectionManager();
  }),
}));

import { QRLConnectProvider } from '../src/QRLConnectProvider.js';
import type { QRLConnectOptions } from '../src/types.js';

describe('QRLConnectProvider', () => {
  let provider: QRLConnectProvider;
  let mockCM: MockConnectionManager;
  const defaultOptions: QRLConnectOptions = {
    dappMetadata: { name: 'Test DApp', url: 'https://test.com' },
    autoReconnect: false,
  };

  beforeEach(() => {
    provider = new QRLConnectProvider(defaultOptions);
    mockCM = latestMockCM;
  });

  afterEach(() => {
    provider.disconnect();
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should set isQRLConnect flag', () => {
      expect(provider.isQRLConnect).toBe(true);
    });

    it('should start disconnected', () => {
      expect(provider.getStatus()).toBe(ConnectionStatus.DISCONNECTED);
    });

    it('should return empty accounts initially', () => {
      expect(provider.getAccounts()).toEqual([]);
    });
  });

  describe('getConnectionURI', () => {
    it('should delegate to ConnectionManager', async () => {
      const uri = await provider.getConnectionURI();
      expect(uri).toBe('qrlconnect://?channelId=mock');
      expect(mockCM.getConnectionURI).toHaveBeenCalledOnce();
    });
  });

  describe('request - local methods', () => {
    it('should handle zond_chainId locally', async () => {
      mockCM.chainId = '0x1';
      const result = await provider.request({ method: 'zond_chainId' });
      expect(result).toBe('0x1');
      expect(mockCM.sendJsonRpc).not.toHaveBeenCalled();
    });

    it('should return cached accounts for zond_accounts', async () => {
      mockCM.accounts = ['Z1234', 'Z5678'];
      const result = await provider.request({ method: 'zond_accounts' });
      expect(result).toEqual(['Z1234', 'Z5678']);
    });
  });

  describe('request - remote methods', () => {
    it('should throw when not connected', async () => {
      await expect(
        provider.request({ method: 'zond_getBalance', params: ['Z1234', 'latest'] })
      ).rejects.toThrow('Not connected to QRL Wallet');
    });

    it('should throw for unsupported methods', async () => {
      await expect(
        provider.request({ method: 'invalid_method' })
      ).rejects.toThrow('Unsupported method: invalid_method');
    });

    it('should send JSON-RPC to wallet when connected', async () => {
      mockCM.status = ConnectionStatus.CONNECTED;

      const requestPromise = provider.request({
        method: 'zond_getBalance',
        params: ['Z1234', 'latest'],
      });

      expect(mockCM.sendJsonRpc).toHaveBeenCalledWith(
        expect.objectContaining({
          jsonrpc: '2.0',
          method: 'zond_getBalance',
          params: ['Z1234', 'latest'],
        })
      );

      // Simulate response from wallet
      const sentRequest = mockCM.sendJsonRpc.mock.calls[0][0];
      mockCM.emit('jsonrpc_response', {
        jsonrpc: '2.0',
        id: sentRequest.id,
        result: '0x1000',
      });

      const result = await requestPromise;
      expect(result).toBe('0x1000');
    });

    it('should reject on error response', async () => {
      mockCM.status = ConnectionStatus.CONNECTED;

      const requestPromise = provider.request({
        method: 'zond_sendTransaction',
        params: [{ to: 'Z1234', value: '0x0' }],
      });

      const sentRequest = mockCM.sendJsonRpc.mock.calls[0][0];
      mockCM.emit('jsonrpc_response', {
        jsonrpc: '2.0',
        id: sentRequest.id,
        error: { code: -32000, message: 'User rejected' },
      });

      await expect(requestPromise).rejects.toThrow('User rejected');
    });
  });

  describe('EIP-1193 events', () => {
    it('should emit connect on CONNECTED status', () => {
      const connectSpy = vi.fn();
      provider.on('connect', connectSpy);

      mockCM.emit('status_changed', ConnectionStatus.CONNECTED);
      expect(connectSpy).toHaveBeenCalledWith({ chainId: '0x0' });
    });

    it('should emit disconnect on DISCONNECTED status', () => {
      const disconnectSpy = vi.fn();
      provider.on('disconnect', disconnectSpy);

      mockCM.emit('status_changed', ConnectionStatus.DISCONNECTED);
      expect(disconnectSpy).toHaveBeenCalledWith({
        code: 4900,
        message: 'Disconnected from QRL Wallet',
      });
    });

    it('should emit accountsChanged', () => {
      const accountsSpy = vi.fn();
      provider.on('accountsChanged', accountsSpy);

      mockCM.emit('accounts_changed', ['Z1111', 'Z2222']);
      expect(accountsSpy).toHaveBeenCalledWith(['Z1111', 'Z2222']);
    });

    it('should emit chainChanged', () => {
      const chainSpy = vi.fn();
      provider.on('chainChanged', chainSpy);

      mockCM.emit('chain_changed', '0x1');
      expect(chainSpy).toHaveBeenCalledWith('0x1');
    });
  });

  describe('connection_lost', () => {
    it('should reject all pending requests on connection lost', async () => {
      mockCM.status = ConnectionStatus.CONNECTED;

      const promise1 = provider.request({ method: 'zond_getBalance', params: ['Z1', 'latest'] });
      const promise2 = provider.request({ method: 'zond_blockNumber' });

      mockCM.emit('connection_lost');

      await expect(promise1).rejects.toThrow('Connection to QRL Wallet lost');
      await expect(promise2).rejects.toThrow('Connection to QRL Wallet lost');
    });
  });

  describe('wallet_info', () => {
    it('should resolve pending zond_requestAccounts', async () => {
      mockCM.status = ConnectionStatus.CONNECTED;

      const requestPromise = provider.request({
        method: 'zond_requestAccounts',
      });

      mockCM.emit('wallet_info', {
        accounts: ['Z1234abcd'],
        chainId: '0x0',
      });

      const result = await requestPromise;
      expect(result).toEqual(['Z1234abcd']);
    });
  });

  describe('disconnect', () => {
    it('should reject pending requests and delegate to ConnectionManager', async () => {
      mockCM.status = ConnectionStatus.CONNECTED;

      const promise = provider.request({ method: 'zond_blockNumber' });

      provider.disconnect();

      await expect(promise).rejects.toThrow('Disconnected');
      expect(mockCM.disconnect).toHaveBeenCalled();
    });
  });

  describe('isConnected', () => {
    it('should return true when status is CONNECTED', () => {
      mockCM.status = ConnectionStatus.CONNECTED;
      expect(provider.isConnected()).toBe(true);
    });

    it('should return false when not connected', () => {
      mockCM.status = ConnectionStatus.DISCONNECTED;
      expect(provider.isConnected()).toBe(false);
    });
  });

  describe('getChannelId', () => {
    it('should delegate to ConnectionManager', () => {
      expect(provider.getChannelId()).toBe('mock-channel');
    });
  });
});
