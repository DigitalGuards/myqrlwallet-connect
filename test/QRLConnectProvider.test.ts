import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import EventEmitter from 'eventemitter3';
import { ConnectionStatus } from '../src/types.js';

// Mock the platform helpers so the wallet-wake redirect can be asserted
// without a browser environment (and without actually navigating anywhere).
const platformMocks = vi.hoisted(() => ({
  isMobileBrowser: vi.fn((): boolean => false),
  attemptWalletRedirect: vi.fn((): Promise<boolean> => Promise.resolve(true)),
}));

vi.mock('../src/utils/platform.js', () => ({
  isMobileBrowser: platformMocks.isMobileBrowser,
  attemptWalletRedirect: platformMocks.attemptWalletRedirect,
  getAppStoreUrl: vi.fn(() => 'https://example.invalid/store'),
}));

// Track all mock instances
let latestMockCM: MockConnectionManager;

class MockConnectionManager extends EventEmitter {
  status = ConnectionStatus.DISCONNECTED;
  accounts: string[] = [];
  chainId = '0x0';
  channelId = 'mock-channel';
  paired = false;
  walletPresent = false;

  constructor() {
    super();
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    latestMockCM = this;
  }

  getStatus() {
    return this.status;
  }
  getAccounts() {
    return this.accounts;
  }
  getChainId() {
    return this.chainId;
  }
  getChannelId() {
    return this.channelId;
  }
  isPaired() {
    return this.paired;
  }
  isWalletPresent() {
    return this.walletPresent;
  }
  getConnectionURI = vi.fn().mockResolvedValue('qrlconnect://?channelId=mock');
  sendJsonRpc = vi.fn().mockResolvedValue(undefined);
  ensureChannelJoined = vi.fn().mockResolvedValue(false);
  hasStoredSession = vi.fn().mockReturnValue(false);
  reconnect = vi.fn().mockResolvedValue(false);
  disconnect = vi.fn();
}

vi.mock('../src/ConnectionManager.js', () => ({
  ConnectionManager: vi.fn().mockImplementation((..._args: unknown[]) => {
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
    it('should handle qrl_chainId locally', async () => {
      mockCM.chainId = '0x1';
      const result = await provider.request({ method: 'qrl_chainId' });
      expect(result).toBe('0x1');
      expect(mockCM.sendJsonRpc).not.toHaveBeenCalled();
    });

    it('should return cached accounts for qrl_accounts', async () => {
      mockCM.accounts = ['Q1234', 'Q5678'];
      const result = await provider.request({ method: 'qrl_accounts' });
      expect(result).toEqual(['Q1234', 'Q5678']);
    });
  });

  describe('request - remote methods', () => {
    it('should throw when not connected', async () => {
      await expect(
        provider.request({ method: 'qrl_getBalance', params: ['Q1234', 'latest'] })
      ).rejects.toThrow('Not connected to QRL Wallet');
    });

    it('should throw for unsupported methods', async () => {
      await expect(provider.request({ method: 'invalid_method' })).rejects.toThrow(
        'Unsupported method: invalid_method'
      );
    });

    it('should send JSON-RPC to wallet when connected', async () => {
      mockCM.status = ConnectionStatus.CONNECTED;

      const requestPromise = provider.request({
        method: 'qrl_getBalance',
        params: ['Q1234', 'latest'],
      });

      expect(mockCM.sendJsonRpc).toHaveBeenCalledWith(
        expect.objectContaining({
          jsonrpc: '2.0',
          method: 'qrl_getBalance',
          params: ['Q1234', 'latest'],
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
        method: 'qrl_sendTransaction',
        params: [{ to: 'Q1234', value: '0x0' }],
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

  describe('request - wallet away (buffered + revive)', () => {
    it('should send while WAITING when a paired session exists', async () => {
      mockCM.status = ConnectionStatus.WAITING;
      mockCM.paired = true;
      mockCM.ensureChannelJoined.mockResolvedValue(true);

      const requestPromise = provider.request({ method: 'qrl_blockNumber' });
      await vi.waitFor(() => { expect(mockCM.sendJsonRpc).toHaveBeenCalled(); });
      expect(mockCM.ensureChannelJoined).toHaveBeenCalledOnce();

      const sentRequest = mockCM.sendJsonRpc.mock.calls[0][0];
      mockCM.emit('jsonrpc_response', {
        jsonrpc: '2.0',
        id: sentRequest.id,
        result: '0x10',
      });
      await expect(requestPromise).resolves.toBe('0x10');
    });

    it('should throw when there is no session to revive', async () => {
      mockCM.status = ConnectionStatus.DISCONNECTED;
      mockCM.ensureChannelJoined.mockResolvedValue(false);

      await expect(provider.request({ method: 'qrl_blockNumber' })).rejects.toThrow(
        'Not connected to QRL Wallet'
      );
      expect(mockCM.sendJsonRpc).not.toHaveBeenCalled();
    });

    it('should answer qrl_requestAccounts from the paired cache without a round-trip', async () => {
      mockCM.status = ConnectionStatus.WAITING;
      mockCM.paired = true;
      mockCM.accounts = ['Q1234'];

      await expect(provider.request({ method: 'qrl_requestAccounts' })).resolves.toEqual([
        'Q1234',
      ]);
      expect(mockCM.ensureChannelJoined).not.toHaveBeenCalled();
      expect(mockCM.sendJsonRpc).not.toHaveBeenCalled();
    });

    it('should reject fast when the send cannot reach the relay', async () => {
      mockCM.status = ConnectionStatus.CONNECTED;
      mockCM.sendJsonRpc.mockReturnValue(Promise.reject(new Error('Socket not connected')));

      await expect(provider.request({ method: 'qrl_blockNumber' })).rejects.toThrow(
        'Socket not connected'
      );
    });
  });

  describe('request - wallet wake redirect', () => {
    beforeEach(() => {
      platformMocks.isMobileBrowser.mockReturnValue(true);
      mockCM.status = ConnectionStatus.WAITING;
      mockCM.paired = true;
      mockCM.walletPresent = false;
      mockCM.ensureChannelJoined.mockResolvedValue(true);
    });

    afterEach(() => {
      platformMocks.isMobileBrowser.mockReturnValue(false);
    });

    /** Resolve the in-flight request so no pending timers leak across tests. */
    async function settleRequest(requestPromise: Promise<unknown>): Promise<void> {
      await vi.waitFor(() => { expect(mockCM.sendJsonRpc).toHaveBeenCalled(); });
      const sentRequest = mockCM.sendJsonRpc.mock.calls[0][0];
      mockCM.emit('jsonrpc_response', { jsonrpc: '2.0', id: sentRequest.id, result: null });
      await requestPromise;
    }

    it('should deep-link the wallet awake for restricted methods when it is absent', async () => {
      const requestPromise = provider.request({
        method: 'qrl_sendTransaction',
        params: [{ to: 'Q1234', value: '0x0' }],
      });

      await vi.waitFor(() =>
        { expect(platformMocks.attemptWalletRedirect).toHaveBeenCalledWith(
          'qrlconnect://resume?cid=mock-channel'
        ); }
      );
      await settleRequest(requestPromise);
    });

    it('should not redirect for unrestricted methods', async () => {
      await settleRequest(provider.request({ method: 'qrl_blockNumber' }));
      expect(platformMocks.attemptWalletRedirect).not.toHaveBeenCalled();
    });

    it('should not redirect while the wallet is present in the channel', async () => {
      mockCM.status = ConnectionStatus.CONNECTED;
      mockCM.walletPresent = true;

      await settleRequest(
        provider.request({ method: 'qrl_sendTransaction', params: [{ to: 'Q1', value: '0x0' }] })
      );
      expect(platformMocks.attemptWalletRedirect).not.toHaveBeenCalled();
    });

    it('should not redirect when walletRedirectOnRequest is false', async () => {
      const optOutProvider = new QRLConnectProvider({
        ...defaultOptions,
        walletRedirectOnRequest: false,
      });
      const optOutCM = latestMockCM;
      optOutCM.status = ConnectionStatus.WAITING;
      optOutCM.paired = true;
      optOutCM.ensureChannelJoined.mockResolvedValue(true);

      const requestPromise = optOutProvider.request({
        method: 'qrl_sendTransaction',
        params: [{ to: 'Q1234', value: '0x0' }],
      });
      await vi.waitFor(() => { expect(optOutCM.sendJsonRpc).toHaveBeenCalled(); });
      const sentRequest = optOutCM.sendJsonRpc.mock.calls[0][0];
      optOutCM.emit('jsonrpc_response', { jsonrpc: '2.0', id: sentRequest.id, result: null });
      await requestPromise;

      expect(platformMocks.attemptWalletRedirect).not.toHaveBeenCalled();
      await optOutProvider.disconnect();
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

      mockCM.emit('accounts_changed', ['Q1111', 'Q2222']);
      expect(accountsSpy).toHaveBeenCalledWith(['Q1111', 'Q2222']);
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

      const promise1 = provider.request({ method: 'qrl_getBalance', params: ['Q1', 'latest'] });
      const promise2 = provider.request({ method: 'qrl_blockNumber' });

      mockCM.emit('connection_lost');

      await expect(promise1).rejects.toThrow('Connection to QRL Wallet lost');
      await expect(promise2).rejects.toThrow('Connection to QRL Wallet lost');
    });
  });

  describe('wallet_info', () => {
    it('should resolve pending qrl_requestAccounts', async () => {
      mockCM.status = ConnectionStatus.CONNECTED;

      const requestPromise = provider.request({
        method: 'qrl_requestAccounts',
      });

      mockCM.emit('wallet_info', {
        accounts: ['Q1234abcd'],
        chainId: '0x0',
      });

      const result = await requestPromise;
      expect(result).toEqual(['Q1234abcd']);
    });
  });

  describe('disconnect', () => {
    it('should reject pending requests and delegate to ConnectionManager', async () => {
      mockCM.status = ConnectionStatus.CONNECTED;

      const promise = provider.request({ method: 'qrl_blockNumber' });

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
