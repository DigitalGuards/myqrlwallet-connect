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
  resetForNewChannel = vi.fn().mockResolvedValue(undefined);
  disconnect = vi.fn().mockResolvedValue(undefined);
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

    it('should cancel active and queued approvals before rotating the channel', async () => {
      mockCM.status = ConnectionStatus.CONNECTED;

      const active = provider.request({
        method: 'qrl_sendTransaction',
        params: [{ to: 'Q1', value: '0x0' }],
      });
      const queued = provider.request({
        method: 'qrl_signMessage',
        params: ['Qaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '0x00'],
      });
      expect(mockCM.sendJsonRpc).toHaveBeenCalledOnce();

      await provider.getConnectionURI();

      await expect(active).rejects.toThrow('Connection reset');
      await expect(queued).rejects.toThrow('Connection reset');
      expect(mockCM.sendJsonRpc).toHaveBeenCalledOnce();

      // Once the replacement pairing is ready, a fresh approval owns the
      // serial slot and no request from the retired wallet crosses into it.
      const fresh = provider.request({
        method: 'qrl_signMessage',
        params: ['Qbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '0x02'],
      });
      expect(mockCM.sendJsonRpc).toHaveBeenCalledTimes(2);
      const sent = mockCM.sendJsonRpc.mock.calls[1][0];
      mockCM.emit('jsonrpc_response', { jsonrpc: '2.0', id: sent.id, result: '0xsigned' });
      await expect(fresh).resolves.toBe('0xsigned');
    });

    it('should reject concurrent URI rotations', async () => {
      let finishRotation!: (uri: string) => void;
      mockCM.getConnectionURI.mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            finishRotation = resolve;
          })
      );

      const first = provider.getConnectionURI();
      await expect(provider.getConnectionURI()).rejects.toThrow(
        'Connection lifecycle transition is already in progress'
      );
      expect(mockCM.getConnectionURI).toHaveBeenCalledOnce();

      finishRotation('qrlconnect://?channelId=replacement');
      await expect(first).resolves.toBe('qrlconnect://?channelId=replacement');
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

    it.each(['qrl_sendRawTransaction', 'qrl_signArbitraryPayload', 'wallet_signArbitraryPayload'])(
      'should fail closed for signing or broadcast method %s',
      async (method) => {
        mockCM.status = ConnectionStatus.CONNECTED;

        await expect(provider.request({ method, params: ['0xdeadbeef'] })).rejects.toThrow(
          `Unsupported method: ${method}`
        );
        expect(mockCM.sendJsonRpc).not.toHaveBeenCalled();
      }
    );

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

    it('should snapshot unrestricted params before caller mutation', async () => {
      mockCM.status = ConnectionStatus.CONNECTED;
      const params = [{ to: 'Q1111', data: '0x01' }, 'latest'];

      const requestPromise = provider.request({ method: 'qrl_call', params });
      const sentRequest = mockCM.sendJsonRpc.mock.calls[0][0];
      params[0].data = '0x02';
      params.push('mutated');

      expect(sentRequest.params).toEqual([{ to: 'Q1111', data: '0x01' }, 'latest']);
      mockCM.emit('jsonrpc_response', {
        jsonrpc: '2.0',
        id: sentRequest.id,
        result: '0xresult',
      });
      await expect(requestPromise).resolves.toBe('0xresult');
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

    it('should serialize approval-bound requests by request id', async () => {
      mockCM.status = ConnectionStatus.CONNECTED;

      const first = provider.request({
        method: 'qrl_sendTransaction',
        params: [{ to: 'Q1111', value: '0x0' }],
      });
      const second = provider.request({
        method: 'qrl_signMessage',
        params: ['Qaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '0x00'],
      });

      expect(mockCM.sendJsonRpc).toHaveBeenCalledTimes(1);
      const firstWire = mockCM.sendJsonRpc.mock.calls[0][0];
      mockCM.emit('jsonrpc_response', {
        jsonrpc: '2.0',
        id: firstWire.id,
        result: '0xhash',
      });
      await expect(first).resolves.toBe('0xhash');

      await vi.waitFor(() => {
        expect(mockCM.sendJsonRpc).toHaveBeenCalledTimes(2);
      });
      const secondWire = mockCM.sendJsonRpc.mock.calls[1][0];
      expect(secondWire.method).toBe('qrl_signMessage');
      expect(secondWire.id).not.toBe(firstWire.id);
      mockCM.emit('jsonrpc_response', {
        jsonrpc: '2.0',
        id: secondWire.id,
        result: { signature: '0xsig' },
      });
      await expect(second).resolves.toEqual({ signature: '0xsig' });
    });

    it('should reject a false-success chain switch response', async () => {
      mockCM.status = ConnectionStatus.CONNECTED;
      mockCM.chainId = '0x1';

      const switched = provider.request({
        method: 'wallet_switchQrlChain',
        params: [{ chainId: '0x539' }],
      });
      const wire = mockCM.sendJsonRpc.mock.calls[0][0];
      mockCM.emit('jsonrpc_response', { jsonrpc: '2.0', id: wire.id, result: null });

      await expect(switched).rejects.toThrow('did not switch to requested chain 0x539');
    });

    it('should accept a chain switch only after wallet state reflects the target', async () => {
      mockCM.status = ConnectionStatus.CONNECTED;
      mockCM.chainId = '0x539';

      const switched = provider.request({
        method: 'wallet_switchQrlChain',
        params: [{ chainId: '0x0539' }],
      });
      const wire = mockCM.sendJsonRpc.mock.calls[0][0];
      mockCM.emit('jsonrpc_response', { jsonrpc: '2.0', id: wire.id, result: null });

      await expect(switched).resolves.toBeNull();
    });

    it('should bind the chain-switch postcondition before caller params can change', async () => {
      mockCM.status = ConnectionStatus.CONNECTED;
      mockCM.chainId = '0x1';
      const params = [{ chainId: '0x539' }];

      const switched = provider.request({ method: 'wallet_switchQrlChain', params });
      const wire = mockCM.sendJsonRpc.mock.calls[0][0];
      params[0].chainId = '0x1';
      expect(wire.params).toEqual([{ chainId: '0x539' }]);
      mockCM.emit('jsonrpc_response', { jsonrpc: '2.0', id: wire.id, result: null });

      await expect(switched).rejects.toThrow('did not switch to requested chain 0x539');
    });

    it('should settle and advance the restricted queue after switch params are mutated', async () => {
      mockCM.status = ConnectionStatus.CONNECTED;
      mockCM.chainId = '0x539';
      const params = [{ chainId: '0x539' }];

      const switched = provider.request({ method: 'wallet_switchQrlChain', params });
      const next = provider.request({
        method: 'qrl_sendTransaction',
        params: [{ to: 'Q1111', value: '0x0' }],
      });
      const switchWire = mockCM.sendJsonRpc.mock.calls[0][0];
      params[0].chainId = 'malformed-after-send';

      expect(() =>
        mockCM.emit('jsonrpc_response', {
          jsonrpc: '2.0',
          id: switchWire.id,
          result: null,
        })
      ).not.toThrow();
      await expect(switched).resolves.toBeNull();

      await vi.waitFor(() => {
        expect(mockCM.sendJsonRpc).toHaveBeenCalledTimes(2);
      });
      const nextWire = mockCM.sendJsonRpc.mock.calls[1][0];
      mockCM.emit('jsonrpc_response', {
        jsonrpc: '2.0',
        id: nextWire.id,
        result: '0xhash',
      });
      await expect(next).resolves.toBe('0xhash');
    });

    it('should clean up and advance the restricted queue after a synchronous send failure', async () => {
      mockCM.status = ConnectionStatus.CONNECTED;
      mockCM.sendJsonRpc.mockImplementationOnce(() => {
        throw new Error('session changed before send');
      });

      const failed = provider.request({
        method: 'qrl_sendTransaction',
        params: [{ to: 'Q1111', value: '0x0' }],
      });
      const next = provider.request({
        method: 'qrl_signMessage',
        params: ['Qaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '0x00'],
      });

      await expect(failed).rejects.toThrow('session changed before send');
      await vi.waitFor(() => {
        expect(mockCM.sendJsonRpc).toHaveBeenCalledTimes(2);
      });
      const nextWire = mockCM.sendJsonRpc.mock.calls[1][0];
      mockCM.emit('jsonrpc_response', {
        jsonrpc: '2.0',
        id: nextWire.id,
        result: { signature: '0xsig' },
      });
      await expect(next).resolves.toEqual({ signature: '0xsig' });
    });

    it('should reject unsafe nested typed data before sending it to the wallet', async () => {
      mockCM.status = ConnectionStatus.CONNECTED;
      const nestedArrayType = `uint8${'[]'.repeat(14)}`;

      await expect(
        provider.request({
          method: 'qrl_signTypedData',
          params: [
            'Qaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            {
              types: {
                QRLDomain: [{ name: 'name', type: 'string' }],
                Payload: [{ name: 'values', type: nestedArrayType }],
              },
              primaryType: 'Payload',
              domain: { name: 'Security test' },
              message: { values: [] },
            },
          ],
        })
      ).rejects.toThrow('type nesting too deep');
      expect(mockCM.sendJsonRpc).not.toHaveBeenCalled();
    });

    it('should enforce current Q-address and message-size rules before signing', async () => {
      mockCM.status = ConnectionStatus.CONNECTED;

      await expect(
        provider.request({ method: 'qrl_signMessage', params: ['Q1234', '0x00'] })
      ).rejects.toThrow('valid Q-address signer');
      await expect(
        provider.request({
          method: 'qrl_signMessage',
          params: [
            'Qaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            `0x${'00'.repeat(16 * 1024 + 1)}`,
          ],
        })
      ).rejects.toThrow('bounded 0x-prefixed bytes');
      expect(mockCM.sendJsonRpc).not.toHaveBeenCalled();
    });

    it('snapshots queued typed data before caller-owned objects can be mutated', async () => {
      mockCM.status = ConnectionStatus.CONNECTED;
      const first = provider.request({
        method: 'qrl_sendTransaction',
        params: [{ to: 'Q1111', value: '0x0' }],
      });
      const payload = {
        types: {
          QRLDomain: [{ name: 'name', type: 'string' }],
          Payload: [{ name: 'values', type: 'uint8[]' }],
        },
        primaryType: 'Payload',
        domain: { name: 'Security test' },
        message: { values: [1] },
      };
      const second = provider.request({
        method: 'qrl_signTypedData',
        params: ['Qaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', payload],
      });
      payload.message.values = new Array(300).fill(7);

      const firstWire = mockCM.sendJsonRpc.mock.calls[0][0];
      mockCM.emit('jsonrpc_response', {
        jsonrpc: '2.0',
        id: firstWire.id,
        result: '0xhash',
      });
      await expect(first).resolves.toBe('0xhash');

      await vi.waitFor(() => {
        expect(mockCM.sendJsonRpc).toHaveBeenCalledTimes(2);
      });
      const secondWire = mockCM.sendJsonRpc.mock.calls[1][0];
      expect(secondWire.params).toEqual([
        'Qaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        expect.objectContaining({ message: { values: [1] } }),
      ]);
      mockCM.emit('jsonrpc_response', {
        jsonrpc: '2.0',
        id: secondWire.id,
        result: { signature: '0xsig' },
      });
      await expect(second).resolves.toEqual({ signature: '0xsig' });
    });
  });

  describe('request - wallet away (buffered + revive)', () => {
    it('should send while WAITING when a paired session exists', async () => {
      mockCM.status = ConnectionStatus.WAITING;
      mockCM.paired = true;
      mockCM.ensureChannelJoined.mockResolvedValue(true);

      const requestPromise = provider.request({ method: 'qrl_blockNumber' });
      await vi.waitFor(() => {
        expect(mockCM.sendJsonRpc).toHaveBeenCalled();
      });
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

      await expect(provider.request({ method: 'qrl_requestAccounts' })).resolves.toEqual(['Q1234']);
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
      await vi.waitFor(() => {
        expect(mockCM.sendJsonRpc).toHaveBeenCalled();
      });
      const sentRequest = mockCM.sendJsonRpc.mock.calls[0][0];
      mockCM.emit('jsonrpc_response', { jsonrpc: '2.0', id: sentRequest.id, result: null });
      await requestPromise;
    }

    it('should deep-link the wallet awake for restricted methods when it is absent', async () => {
      const requestPromise = provider.request({
        method: 'qrl_sendTransaction',
        params: [{ to: 'Q1234', value: '0x0' }],
      });

      await vi.waitFor(() => {
        expect(platformMocks.attemptWalletRedirect).toHaveBeenCalledWith(
          'qrlconnect://?wake=mock-channel'
        );
      });
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

    it('should not redirect for qrl_requestAccounts even when otherwise eligible', async () => {
      // An empty account cache falls through the cached-accounts early
      // return and sends, but the redirect must still not fire: dApps call
      // qrl_requestAccounts on page load with no user gesture.
      mockCM.accounts = [];

      const requestPromise = provider.request({ method: 'qrl_requestAccounts' });
      await vi.waitFor(() => {
        expect(mockCM.sendJsonRpc).toHaveBeenCalled();
      });
      expect(platformMocks.attemptWalletRedirect).not.toHaveBeenCalled();

      mockCM.emit('wallet_info', {
        accounts: ['Q1111111111111111111111111111111111111111'],
        chainId: '0x0',
      });
      await expect(requestPromise).resolves.toEqual([
        'Q1111111111111111111111111111111111111111',
      ]);
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
      await vi.waitFor(() => {
        expect(optOutCM.sendJsonRpc).toHaveBeenCalled();
      });
      const sentRequest = optOutCM.sendJsonRpc.mock.calls[0][0];
      optOutCM.emit('jsonrpc_response', { jsonrpc: '2.0', id: sentRequest.id, result: null });
      await requestPromise;

      expect(platformMocks.attemptWalletRedirect).not.toHaveBeenCalled();
      await optOutProvider.disconnect();
    });
  });

  describe('late responses after a page reload', () => {
    const INFLIGHT_KEY = '@qrlwallet/connect:session:inflight';
    let store: Map<string, string>;

    beforeEach(() => {
      store = new Map();
      vi.stubGlobal('localStorage', {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => {
          store.set(k, v);
        },
        removeItem: (k: string) => {
          store.delete(k);
        },
      });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('persists restricted in-flight ids and emits late_response on a reloaded provider', async () => {
      const firstProvider = new QRLConnectProvider(defaultOptions);
      const firstCM = latestMockCM;
      firstCM.status = ConnectionStatus.CONNECTED;
      const requestPromise = firstProvider.request({
        method: 'qrl_sendTransaction',
        params: [{ to: 'Q1', value: '0x0' }],
      });
      const sentRequest = firstCM.sendJsonRpc.mock.calls[0][0];
      expect(store.has(INFLIGHT_KEY)).toBe(true);

      // "Reload": a fresh provider over the same storage, no pending map.
      const reloaded = new QRLConnectProvider(defaultOptions);
      const reloadedCM = latestMockCM;
      const late = vi.fn();
      reloaded.on('late_response', late);

      reloadedCM.emit('jsonrpc_response', {
        jsonrpc: '2.0',
        id: sentRequest.id,
        result: '0xhash',
      });

      expect(late).toHaveBeenCalledWith({
        id: sentRequest.id,
        method: 'qrl_sendTransaction',
        result: '0xhash',
      });
      // Consumed: storage cleared, no double emission on a further response.
      expect(store.has(INFLIGHT_KEY)).toBe(false);

      await reloaded.disconnect();
      await firstProvider.disconnect();
      await expect(requestPromise).rejects.toThrow('Disconnected');
    });

    it('clears the persisted record when the original request settles normally', async () => {
      const p = new QRLConnectProvider(defaultOptions);
      const cm = latestMockCM;
      cm.status = ConnectionStatus.CONNECTED;
      const requestPromise = p.request({
        method: 'qrl_signMessage',
        params: ['Qaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '0x00'],
      });
      const sentRequest = cm.sendJsonRpc.mock.calls[0][0];
      expect(store.has(INFLIGHT_KEY)).toBe(true);

      cm.emit('jsonrpc_response', { jsonrpc: '2.0', id: sentRequest.id, result: { ok: true } });
      await requestPromise;
      expect(store.has(INFLIGHT_KEY)).toBe(false);
      await p.disconnect();
    });

    it('does not emit a false-success late chain-switch response', async () => {
      store.set(
        INFLIGHT_KEY,
        JSON.stringify([
          {
            id: 'old-switch',
            method: 'wallet_switchQrlChain',
            expectedChainId: '0x539',
            ts: Date.now(),
          },
        ])
      );
      const reloaded = new QRLConnectProvider(defaultOptions);
      const reloadedCM = latestMockCM;
      reloadedCM.chainId = '0x1';
      const late = vi.fn();
      reloaded.on('late_response', late);

      reloadedCM.emit('jsonrpc_response', {
        jsonrpc: '2.0',
        id: 'old-switch',
        result: null,
      });

      expect(late).toHaveBeenCalledWith({
        id: 'old-switch',
        method: 'wallet_switchQrlChain',
        error: {
          code: -32000,
          message: 'Wallet reported success but did not switch to requested chain 0x539',
        },
      });
      expect(store.has(INFLIGHT_KEY)).toBe(false);
      await reloaded.disconnect();
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

  describe('session_terminated', () => {
    it('should reject all pending requests when the session is terminated', async () => {
      mockCM.status = ConnectionStatus.CONNECTED;

      const promise = provider.request({ method: 'qrl_blockNumber' });

      mockCM.emit('session_terminated');

      await expect(promise).rejects.toThrow('Session terminated by wallet');
    });

    it('should reject approval requests that were queued but never sent', async () => {
      mockCM.status = ConnectionStatus.CONNECTED;

      const active = provider.request({
        method: 'qrl_sendTransaction',
        params: [{ to: 'Q1', value: '0x0' }],
      });
      const queued = provider.request({
        method: 'qrl_signMessage',
        params: ['Qaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '0x00'],
      });
      expect(mockCM.sendJsonRpc).toHaveBeenCalledOnce();

      mockCM.emit('session_terminated');

      await expect(active).rejects.toThrow('Session terminated by wallet');
      await expect(queued).rejects.toThrow('Session terminated by wallet');
      expect(mockCM.sendJsonRpc).toHaveBeenCalledOnce();
    });
  });

  describe('wallet_info', () => {
    it('should resolve pending qrl_requestAccounts', async () => {
      mockCM.status = ConnectionStatus.CONNECTED;

      const requestPromise = provider.request({
        method: 'qrl_requestAccounts',
      });

      mockCM.emit('wallet_info', {
        accounts: ['Q1111111111111111111111111111111111111111'],
        chainId: '0x0',
      });

      const result = await requestPromise;
      expect(result).toEqual(['Q1111111111111111111111111111111111111111']);
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

    it('should cancel a request that has not reached the pending map while rejoining', async () => {
      mockCM.status = ConnectionStatus.WAITING;
      let finishJoin!: (joined: boolean) => void;
      mockCM.ensureChannelJoined.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            finishJoin = resolve;
          })
      );

      const request = provider.request({
        method: 'qrl_sendTransaction',
        params: [{ to: 'Q1111', value: '0x0' }],
      });
      await vi.waitFor(() => {
        expect(mockCM.ensureChannelJoined).toHaveBeenCalledOnce();
      });

      const disconnect = provider.disconnect();
      finishJoin(true);

      await expect(request).rejects.toThrow('Disconnected');
      await disconnect;
      expect(mockCM.sendJsonRpc).not.toHaveBeenCalled();
    });

    it('should reject new requests until an explicit disconnect finishes', async () => {
      mockCM.status = ConnectionStatus.CONNECTED;
      let finishDisconnect!: () => void;
      mockCM.disconnect.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishDisconnect = resolve;
          })
      );

      const disconnect = provider.disconnect();
      await expect(provider.request({ method: 'qrl_blockNumber' })).rejects.toThrow('Disconnected');
      expect(mockCM.sendJsonRpc).not.toHaveBeenCalled();

      finishDisconnect();
      await disconnect;
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
