import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import EventEmitter from 'eventemitter3';
import { ConnectionStatus, KeyExchangeMessageType } from '../src/types.js';
import * as qrUri from '../src/utils/qrUri.js';

// Track latest mock instances (same pattern as QRLConnectProvider.test.ts)
let latestMockSocket: MockSocketClient;
let latestMockKex: MockKeyExchange;
let nextJoinError: Error | null = null;
const TERMINATE_TEST_TIMEOUT_MS = 801;
const VALID_SYNACK_CT = btoa(String.fromCharCode(...new Uint8Array(1088)));
const VALID_SYNACK_C0 = btoa(String.fromCharCode(...new Uint8Array(31)));
const ADDRESS_A = `Q${'a'.repeat(128)}`;
const ADDRESS_B = `Q${'b'.repeat(128)}`;
const ADDRESS_C = `Q${'c'.repeat(128)}`;
const ADDRESS_1 = `Q${'1'.repeat(128)}`;

const PERSISTED_KEX = {
  protocolVersion: 3,
  cid: 'ERERERERQRGBEREREREREQ==',
  kAeadRaw: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  htx: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  sendDir: 'AAAAAQ==',
  recvDir: 'AAAAAg==',
  sendSeq: 4,
  recvSeq: 7,
};

function fakeLockManager(): LockManager {
  let held = false;
  return {
    request: vi.fn(
      async <T>(
        name: string,
        _options: LockOptions,
        callback: (lock: Lock | null) => T | PromiseLike<T>
      ): Promise<T> => {
        if (held) return callback(null);
        held = true;
        try {
          return await callback({ name, mode: 'exclusive' });
        } finally {
          held = false;
        }
      }
    ),
  } as unknown as LockManager;
}

function deferredLockManager(): {
  manager: LockManager;
  dispatch: () => Promise<void>;
} {
  let callback: ((lock: Lock | null) => void | PromiseLike<void>) | null = null;
  let resolveRequest: (() => void) | null = null;
  let rejectRequest: ((error: unknown) => void) | null = null;
  const manager = {
    request: vi.fn(
      (
        _name: string,
        _options: LockOptions,
        lockCallback: (lock: Lock | null) => void | PromiseLike<void>
      ): Promise<void> => {
        callback = lockCallback;
        return new Promise<void>((resolve, reject) => {
          resolveRequest = resolve;
          rejectRequest = reject;
        });
      }
    ),
  } as unknown as LockManager;

  return {
    manager,
    dispatch: async () => {
      if (!callback || !resolveRequest || !rejectRequest) {
        throw new Error('No deferred lock request');
      }
      try {
        await callback({ name: 'test:aead-owner', mode: 'exclusive' });
        resolveRequest();
      } catch (error) {
        rejectRequest(error);
      }
    },
  };
}

function installBrowserStorage(
  options: {
    failReads?: boolean;
    failWrites?: boolean;
    failRemoves?: boolean;
    lockManager?: LockManager;
  } = {}
): Map<string, string> {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => {
      if (options.failReads) throw new Error('read denied');
      return values.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (options.failWrites) throw new Error('quota denied');
      values.set(key, value);
    },
    removeItem: (key: string) => {
      if (options.failRemoves) throw new Error('removal denied');
      values.delete(key);
    },
  });
  vi.stubGlobal('navigator', { locks: options.lockManager ?? fakeLockManager() });
  return values;
}

function storedSession(sendSeq = 4): string {
  return JSON.stringify({
    version: 5,
    channelId: '11111111-1111-4111-8111-111111111111',
    keyExchange: { ...PERSISTED_KEX, sendSeq },
    dappMetadata: { name: 'Stored dApp', url: 'https://stored.invalid' },
    connectedAccounts: [ADDRESS_A],
    chainId: '0x539',
    createdAt: Date.now(),
    lastActivity: Date.now(),
  });
}

class MockSocketClient extends EventEmitter {
  channelId: string | null = null;
  connected = false;

  constructor() {
    super();
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    latestMockSocket = this;
  }

  setPublicKey = vi.fn();
  connect = vi.fn(() => {
    this.connected = true;
  });
  joinChannel = vi.fn((channelId: string) => {
    if (nextJoinError) {
      const error = nextJoinError;
      nextJoinError = null;
      return Promise.reject(error);
    }
    this.channelId = channelId;
    return Promise.resolve({
      bufferedMessages: [],
      channelPublicKey: null,
      participants: ['wallet'],
      terminated: false,
    });
  });
  sendMessage = vi.fn().mockResolvedValue({ success: true, buffered: false });
  leaveChannel = vi.fn(() => {
    this.channelId = null;
  });
  closeChannel = vi.fn(() => {
    this.channelId = null;
    return Promise.resolve(true);
  });
  disconnect = vi.fn(() => {
    this.connected = false;
    this.channelId = null;
  });
  isConnected() {
    return this.connected;
  }
  getChannelId() {
    return this.channelId;
  }
}

class MockKeyExchange extends EventEmitter {
  exchanged = false;

  constructor() {
    super();
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    latestMockKex = this;
  }

  initiate = vi.fn(() => ({
    publicKey: new Uint8Array(1184),
    capability: new Uint8Array(32).fill(0xa5),
  }));
  reset = vi.fn(() => {
    this.exchanged = false;
  });
  areKeysExchanged() {
    return this.exchanged;
  }
  decryptMessage = vi.fn();
  encryptMessage = vi.fn().mockResolvedValue('ciphertext');
  exportPersisted = vi.fn().mockResolvedValue(null);
  onSynAck = vi.fn();
  getLastAck = vi.fn(() => null);
  confirmOriginatorAckDelivered = vi.fn(() => {
    if (this.exchanged) return;
    this.exchanged = true;
    this.emit('keys_exchanged');
  });
}

vi.mock('../src/SocketClient.js', () => ({
  SocketClient: vi.fn().mockImplementation(function () {
    return new MockSocketClient();
  }),
}));

vi.mock('../src/KeyExchange.js', () => ({
  SYNACK_C0_LEN: 31,
  KeyExchange: Object.assign(
    vi.fn().mockImplementation(function () {
      return new MockKeyExchange();
    }),
    { sessionFromPersisted: vi.fn() }
  ),
}));

import { ConnectionManager } from '../src/ConnectionManager.js';

/** Construct a manager with a completed (mock) handshake on a live socket. */
async function pairedManager() {
  const cm = new ConnectionManager({
    dappMetadata: { name: 'Test dApp', url: 'https://test.invalid' },
  });
  await cm.getConnectionURI();
  const socket = latestMockSocket;
  const kex = latestMockKex;
  kex.exchanged = true;
  return { cm, socket, kex };
}

function walletCiphertext(cm: ConnectionManager): {
  id: string;
  clientType: string;
  message: string;
} {
  return { id: cm.getChannelId(), clientType: 'wallet', message: 'opaque-ciphertext' };
}

function walletSynAck(cm: ConnectionManager) {
  return {
    id: cm.getChannelId(),
    clientType: 'wallet',
    message: {
      type: KeyExchangeMessageType.SYNACK,
      ct: VALID_SYNACK_CT,
      c0: VALID_SYNACK_C0,
      v: 3,
    },
  };
}

describe('ConnectionManager desync teardown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nextJoinError = null;
  });

  afterEach(() => {
    if (vi.isMockFunction(qrUri.generateConnectionURI)) {
      vi.mocked(qrUri.generateConnectionURI).mockRestore();
    }
    vi.unstubAllGlobals();
  });

  it('canonicalizes credential-free HTTP(S) dApp and redirect metadata URLs', async () => {
    const cm = new ConnectionManager({
      dappMetadata: {
        name: 'Canonical metadata',
        url: 'HTTPS://DAPP.Example:443/a/../home?mode=1#section',
        redirectUrl: 'https://Return.Example:443/path/../done?flow=mobile#state',
      },
    });
    await cm.getConnectionURI();
    const kex = latestMockKex;
    kex.exchanged = true;
    kex.emit('keys_exchanged');

    await vi.waitFor(() => {
      expect(kex.encryptMessage).toHaveBeenCalledOnce();
    });
    const payload = JSON.parse(kex.encryptMessage.mock.calls[0][0]) as {
      originatorInfo: { url: string; redirectUrl: string };
    };
    expect(payload.originatorInfo.url).toBe('https://dapp.example/home?mode=1#section');
    expect(payload.originatorInfo.redirectUrl).toBe(
      'https://return.example/done?flow=mobile#state'
    );
    await cm.disconnect();
  });

  it.each([
    ['url', 'javascript:alert(1)'],
    ['url', 'https://user:secret@dapp.example/'],
    ['url', 'http://dapp.example/'],
    ['url', 'http://127.0.0.2/'],
    ['url', 'mydapp://return'],
    ['redirectUrl', 'javascript:alert(1)'],
    ['redirectUrl', 'https://user:secret@dapp.example/return'],
    ['redirectUrl', 'http://dapp.example/return'],
    ['redirectUrl', 'http://127.0.0.2/return'],
    ['redirectUrl', 'mydapp://return'],
  ] as const)('rejects unsafe dApp metadata %s %s', (field, value) => {
    expect(
      () =>
        new ConnectionManager({
          dappMetadata: {
            name: 'Unsafe metadata',
            url: 'https://safe.example/',
            redirectUrl: 'https://safe.example/return',
            [field]: value,
          },
        })
    ).toThrow('Invalid or unbounded dApp metadata');
  });

  it.each([
    ['embedded C0 control', 'Safe\u0000evil.example'],
    ['DEL control', 'Safe\u007fevil.example'],
    ['C1 control', 'Safe\u0085evil.example'],
    ['Arabic letter mark', 'Safe\u061cevil.example'],
    ['zero-width text', 'Safe\u200bevil.example'],
    ['bidi mark', 'Safe\u200eevil.example'],
    ['line separator', 'Safe\u2028evil.example'],
    ['paragraph separator', 'Safe\u2029evil.example'],
    ['bidi override', 'Safe\u202eevil.example'],
    ['word joiner', 'Safe\u2060evil.example'],
    ['bidi isolate', 'Safe\u2066evil.example'],
    ['byte-order mark', 'Safe\ufeffevil.example'],
  ] as const)('rejects %s in a dApp display name before pairing', (_label, name) => {
    expect(
      () =>
        new ConnectionManager({
          dappMetadata: {
            name,
            url: 'https://safe.example/',
          },
        })
    ).toThrow('Invalid or unbounded dApp metadata');
  });

  it('accepts plain HTTP metadata only on explicit localhost hostnames', async () => {
    for (const [url, redirectUrl] of [
      ['http://dev.localhost:5173/app', 'http://localhost:5173/return'],
      ['http://127.0.0.1:5173/app', 'http://127.0.0.1:5173/return'],
      ['http://[::1]:5173/app', 'http://[::1]:5173/return'],
    ]) {
      const cm = new ConnectionManager({
        dappMetadata: { name: 'Local development', url, redirectUrl },
      });
      await cm.disconnect();
    }
  });

  it('terminates the session after two consecutive AEAD open failures', async () => {
    const { cm, socket, kex } = await pairedManager();
    kex.decryptMessage.mockRejectedValue(new Error('AEAD tag failed'));
    const terminated = vi.fn();
    cm.on('session_terminated', terminated);

    socket.emit('message', walletCiphertext(cm));
    socket.emit('message', walletCiphertext(cm));

    await vi.waitFor(() => {
      expect(terminated).toHaveBeenCalledOnce();
    });
    // Tombstone lands via the relay-level close, not an encrypted TERMINATE
    // (a desynced peer could not open one).
    expect(socket.closeChannel).toHaveBeenCalledOnce();
    expect(cm.getStatus()).toBe(ConnectionStatus.DISCONNECTED);
    expect(cm.isPaired()).toBe(false);
    // Nothing left to revive.
    await expect(cm.ensureChannelJoined()).resolves.toBe(false);
  });

  it('zeroizes an abandoned pre-handshake key exchange on reset', async () => {
    const cm = new ConnectionManager({
      dappMetadata: { name: 'Reset handshake', url: 'https://reset.invalid' },
    });
    await cm.getConnectionURI();
    const pendingKex = latestMockKex;

    await cm.resetForNewChannel();

    expect(pendingKex.reset).toHaveBeenCalledOnce();
  });

  it('zeroizes an abandoned pre-handshake key exchange on disconnect', async () => {
    const cm = new ConnectionManager({
      dappMetadata: { name: 'Disconnect handshake', url: 'https://disconnect.invalid' },
    });
    await cm.getConnectionURI();
    const pendingKex = latestMockKex;

    await cm.disconnect();

    expect(pendingKex.reset).toHaveBeenCalledOnce();
  });

  it('tombstones the old channel and clears authorization before generating another URI', async () => {
    const { cm, socket: oldSocket } = await pairedManager();
    const oldChannelId = cm.getChannelId();
    const account = ADDRESS_A;
    await cm.authorizeAccounts([account]);
    const accountsChanged = vi.fn();
    cm.on('accounts_changed', accountsChanged);

    const nextUri = await cm.getConnectionURI();

    expect(nextUri).toMatch(/^qrlconnect:/);
    expect(oldSocket.closeChannel).toHaveBeenCalledOnce();
    expect(cm.getChannelId()).not.toBe(oldChannelId);
    expect(cm.getAccounts()).toEqual([]);
    expect(accountsChanged).toHaveBeenCalledWith([]);
  });

  it('joins and tombstones a cold stored channel before replacing it', async () => {
    const values = installBrowserStorage();
    values.set('@qrlwallet/connect:session', storedSession());
    const cm = new ConnectionManager({
      dappMetadata: { name: 'Cold rotation', url: 'https://cold-rotation.invalid' },
    });
    const oldSocket = latestMockSocket;
    const accountsChanged = vi.fn();
    cm.on('accounts_changed', accountsChanged);

    await expect(cm.getConnectionURI()).resolves.toMatch(/^qrlconnect:/);

    expect(oldSocket.joinChannel).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');
    expect(oldSocket.closeChannel).toHaveBeenCalledOnce();
    expect(cm.getAccounts()).toEqual([]);
    expect(accountsChanged).toHaveBeenCalledWith([]);
  });

  it('joins and tombstones a cold stored channel on disconnect', async () => {
    const values = installBrowserStorage();
    values.set('@qrlwallet/connect:session', storedSession());
    const cm = new ConnectionManager({
      dappMetadata: { name: 'Cold disconnect', url: 'https://cold-disconnect.invalid' },
    });
    const socket = latestMockSocket;

    await cm.disconnect();

    expect(socket.joinChannel).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');
    expect(socket.closeChannel).toHaveBeenCalledOnce();
    expect(values.has('@qrlwallet/connect:session')).toBe(false);
    expect(cm.getAccounts()).toEqual([]);
  });

  it('retires the socket and handshake when an initial channel join fails', async () => {
    const cm = new ConnectionManager({
      dappMetadata: { name: 'Failed join', url: 'https://failed-join.invalid' },
    });
    nextJoinError = new Error('relay unavailable');

    await expect(cm.getConnectionURI()).rejects.toThrow('relay unavailable');

    const socket = latestMockSocket;
    expect(socket.leaveChannel).toHaveBeenCalledOnce();
    expect(socket.disconnect).toHaveBeenCalledOnce();
    expect(latestMockKex.reset).toHaveBeenCalledOnce();
    expect(cm.isPaired()).toBe(false);
    expect(cm.getStatus()).toBe(ConnectionStatus.DISCONNECTED);
  });

  it('retires capability, transport, and Web Lock when URI generation fails', async () => {
    const locks = fakeLockManager();
    installBrowserStorage({ lockManager: locks });
    vi.spyOn(qrUri, 'generateConnectionURI').mockRejectedValueOnce(
      new Error('fingerprint generation failed')
    );
    const cm = new ConnectionManager({
      dappMetadata: { name: 'Failed URI', url: 'https://failed-uri.invalid' },
    });

    await expect(cm.getConnectionURI()).rejects.toThrow('fingerprint generation failed');

    const failedKex = latestMockKex;
    const failedSocket = latestMockSocket;
    const initiated = failedKex.initiate.mock.results[0]!.value;
    expect(Array.from(initiated.capability)).toEqual(new Array(32).fill(0));
    expect(failedKex.reset).toHaveBeenCalledOnce();
    expect(failedSocket.leaveChannel).toHaveBeenCalledOnce();
    expect(failedSocket.disconnect).toHaveBeenCalledOnce();
    expect(cm.getStatus()).toBe(ConnectionStatus.DISCONNECTED);
    expect(cm.isPaired()).toBe(false);

    const second = new ConnectionManager({
      dappMetadata: { name: 'Second tab', url: 'https://second.invalid' },
    });
    await expect(second.getConnectionURI()).resolves.toMatch(/^qrlconnect:/);
    await second.disconnect();
  });

  it('tombstones and retires a pairing after SYNACK authentication fails', async () => {
    const cm = new ConnectionManager({
      dappMetadata: { name: 'Rejected handshake', url: 'https://rejected.invalid' },
    });
    await cm.getConnectionURI();
    const socket = latestMockSocket;
    const kex = latestMockKex;
    kex.onSynAck.mockRejectedValueOnce(new Error('wallet hello AEAD tag failed'));
    const terminated = vi.fn();
    cm.on('session_terminated', terminated);

    socket.emit('message', {
      id: cm.getChannelId(),
      clientType: 'wallet',
      message: {
        type: KeyExchangeMessageType.SYNACK,
        ct: VALID_SYNACK_CT,
        c0: VALID_SYNACK_C0,
        v: 3,
      },
    });

    await vi.waitFor(() => {
      expect(terminated).toHaveBeenCalledOnce();
    });
    expect(socket.closeChannel).toHaveBeenCalledOnce();
    expect(kex.reset).toHaveBeenCalledOnce();
    expect(cm.getStatus()).toBe(ConnectionStatus.DISCONNECTED);
    expect(cm.isPaired()).toBe(false);
  });

  it('publishes the session only after the relay acknowledges the originator ACK', async () => {
    const cm = new ConnectionManager({
      dappMetadata: { name: 'ACK gate', url: 'https://ack-gate.invalid' },
    });
    await cm.getConnectionURI();
    const socket = latestMockSocket;
    const kex = latestMockKex;
    kex.onSynAck.mockResolvedValueOnce({
      type: KeyExchangeMessageType.ACK,
      c1: btoa(String.fromCharCode(...new Uint8Array(29))),
      v: 3,
    });
    let acknowledge!: () => void;
    const pendingAck = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    socket.sendMessage.mockImplementationOnce(() => pendingAck);

    socket.emit('message', walletSynAck(cm));

    await vi.waitFor(() => {
      expect(socket.sendMessage).toHaveBeenCalledOnce();
    });
    expect(kex.confirmOriginatorAckDelivered).not.toHaveBeenCalled();
    expect(kex.encryptMessage).not.toHaveBeenCalled();
    expect(cm.getStatus()).toBe(ConnectionStatus.KEY_EXCHANGE);
    expect(cm.isPaired()).toBe(false);

    acknowledge();
    await vi.waitFor(() => {
      expect(kex.confirmOriginatorAckDelivered).toHaveBeenCalledOnce();
      expect(kex.encryptMessage).toHaveBeenCalledOnce();
    });
    expect(cm.getStatus()).toBe(ConnectionStatus.CONNECTED);
    expect(cm.isPaired()).toBe(true);
  });

  it('queues originator identity before a synchronous CONNECTED listener request', async () => {
    const cm = new ConnectionManager({
      dappMetadata: { name: 'Ordering gate', url: 'https://ordering.invalid' },
    });
    await cm.getConnectionURI();
    const socket = latestMockSocket;
    const kex = latestMockKex;
    const requestSends: Promise<void>[] = [];

    cm.on('status_changed', (status) => {
      if (status !== ConnectionStatus.CONNECTED) return;
      requestSends.push(
        cm.sendJsonRpc({
          jsonrpc: '2.0',
          id: 'sync-request-accounts',
          method: 'qrl_requestAccounts',
          params: [],
        })
      );
    });

    kex.exchanged = true;
    kex.emit('keys_exchanged');

    await vi.waitFor(() => {
      expect(kex.encryptMessage).toHaveBeenCalledTimes(2);
    });
    const encryptedPayloads = kex.encryptMessage.mock.calls.map(
      ([plaintext]) => JSON.parse(plaintext) as { type: string; method?: string }
    );
    expect(encryptedPayloads).toEqual([
      expect.objectContaining({ type: 'originator_info' }),
      expect.objectContaining({ type: 'jsonrpc', method: 'qrl_requestAccounts' }),
    ]);
    await Promise.all(requestSends);
    expect(socket.sendMessage).toHaveBeenCalledTimes(2);
    await cm.disconnect();
  });

  it('retires a provisional session when ACK delivery is ambiguous', async () => {
    const stored = installBrowserStorage();
    const cm = new ConnectionManager({
      dappMetadata: { name: 'Failed ACK', url: 'https://failed-ack.invalid' },
    });
    await cm.getConnectionURI();
    const socket = latestMockSocket;
    const kex = latestMockKex;
    kex.onSynAck.mockResolvedValueOnce({
      type: KeyExchangeMessageType.ACK,
      c1: btoa(String.fromCharCode(...new Uint8Array(29))),
      v: 3,
    });
    socket.sendMessage.mockRejectedValueOnce(new Error('relay ack lost'));
    const terminated = vi.fn();
    cm.on('session_terminated', terminated);

    socket.emit('message', walletSynAck(cm));

    await vi.waitFor(() => {
      expect(terminated).toHaveBeenCalledOnce();
    });
    expect(kex.confirmOriginatorAckDelivered).not.toHaveBeenCalled();
    expect(kex.encryptMessage).not.toHaveBeenCalled();
    expect(kex.reset).toHaveBeenCalledOnce();
    expect(socket.closeChannel).toHaveBeenCalledOnce();
    expect(cm.isPaired()).toBe(false);
    expect(cm.getStatus()).toBe(ConnectionStatus.DISCONNECTED);
    expect(stored.size).toBe(0);
  });

  it('queues an early wallet ciphertext until ACK delivery completes', async () => {
    const cm = new ConnectionManager({
      dappMetadata: { name: 'ACK race', url: 'https://ack-race.invalid' },
    });
    await cm.getConnectionURI();
    const socket = latestMockSocket;
    const kex = latestMockKex;
    kex.onSynAck.mockResolvedValueOnce({
      type: KeyExchangeMessageType.ACK,
      c1: btoa(String.fromCharCode(...new Uint8Array(29))),
      v: 3,
    });
    kex.decryptMessage.mockResolvedValue(
      JSON.stringify({ type: 'wallet_info', accounts: [], chainId: '0x1' })
    );
    let acknowledge!: () => void;
    const pendingAck = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    socket.sendMessage.mockImplementationOnce(() => pendingAck);

    socket.emit('message', walletSynAck(cm));
    socket.emit('message', walletCiphertext(cm));

    await vi.waitFor(() => {
      expect(socket.sendMessage).toHaveBeenCalledOnce();
    });
    expect(kex.decryptMessage).not.toHaveBeenCalled();

    acknowledge();
    await vi.waitFor(() => {
      expect(kex.decryptMessage).toHaveBeenCalledOnce();
    });
    expect(kex.confirmOriginatorAckDelivered).toHaveBeenCalledOnce();
    expect(cm.getStatus()).toBe(ConnectionStatus.CONNECTED);
  });

  it('drops cross-channel and self-role envelopes before they reach session state', async () => {
    const { cm, socket, kex } = await pairedManager();
    kex.decryptMessage.mockRejectedValue(new Error('must not be reached'));
    const channelId = cm.getChannelId();

    socket.emit('message', {
      id: '22222222-2222-4222-8222-222222222222',
      clientType: 'wallet',
      message: 'cross-channel-ciphertext',
    });
    socket.emit('message', {
      id: channelId,
      clientType: 'dapp',
      message: 'self-role-ciphertext',
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(kex.decryptMessage).not.toHaveBeenCalled();
    expect(socket.closeChannel).not.toHaveBeenCalled();
    expect(cm.isPaired()).toBe(true);
  });

  it('drops oversized or non-canonical SYNACK fields before key exchange decoding', async () => {
    const cm = new ConnectionManager({
      dappMetadata: { name: 'Bounded handshake', url: 'https://bounded.invalid' },
    });
    await cm.getConnectionURI();
    const socket = latestMockSocket;
    const kex = latestMockKex;

    socket.emit('message', {
      id: cm.getChannelId(),
      clientType: 'wallet',
      message: {
        type: KeyExchangeMessageType.SYNACK,
        ct: `${VALID_SYNACK_CT}AAAA`,
        c0: VALID_SYNACK_C0,
        v: 3,
      },
    });
    socket.emit('message', {
      id: cm.getChannelId(),
      clientType: 'wallet',
      message: {
        type: KeyExchangeMessageType.SYNACK,
        ct: VALID_SYNACK_CT,
        c0: `${VALID_SYNACK_C0.slice(0, -2)}AB`,
        v: 3,
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(kex.onSynAck).not.toHaveBeenCalled();
    expect(socket.closeChannel).not.toHaveBeenCalled();
    expect(cm.getStatus()).toBe(ConnectionStatus.WAITING);
    await cm.disconnect();
  });

  it('resets the failure counter on a successful decrypt', async () => {
    const { cm, socket, kex } = await pairedManager();
    kex.decryptMessage
      .mockRejectedValueOnce(new Error('AEAD tag failed'))
      .mockResolvedValueOnce(
        JSON.stringify({
          type: 'wallet_info',
          accounts: [ADDRESS_1],
          chainId: '0x1',
        })
      )
      .mockRejectedValueOnce(new Error('AEAD tag failed'));
    const terminated = vi.fn();
    cm.on('session_terminated', terminated);

    socket.emit('message', walletCiphertext(cm));
    socket.emit('message', walletCiphertext(cm));
    socket.emit('message', walletCiphertext(cm));

    await vi.waitFor(() => {
      expect(kex.decryptMessage).toHaveBeenCalledTimes(3);
    });
    expect(socket.closeChannel).not.toHaveBeenCalled();
    expect(terminated).not.toHaveBeenCalled();
    expect(cm.isPaired()).toBe(true);
  });

  it('counts transport flaps until a channel rejoin actually succeeds', async () => {
    const { cm, socket } = await pairedManager();
    const lost = vi.fn();
    cm.on('connection_lost', lost);

    for (let attempt = 0; attempt < 5; attempt++) {
      socket.emit('disconnected', 'transport close');
      // A transport connection alone is not a successful channel rejoin.
      socket.emit('connected');
    }

    expect(lost).toHaveBeenCalledOnce();
    expect(cm.getStatus()).toBe(ConnectionStatus.RECONNECTING);
  });

  it('drains an auto-rejoin backlog once and persists counters before CONNECTED', async () => {
    const order: string[] = [];
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        order.push('persist');
        values.set(key, value);
      },
      removeItem: (key: string) => values.delete(key),
    });
    vi.stubGlobal('navigator', { locks: fakeLockManager() });
    const { cm, socket, kex } = await pairedManager();
    kex.exportPersisted.mockResolvedValue({ ...PERSISTED_KEX });
    kex.decryptMessage.mockImplementation((ciphertext: string) => {
      order.push(`decrypt:${ciphertext}`);
      return Promise.resolve(
        JSON.stringify({
          type: 'jsonrpc',
          jsonrpc: '2.0',
          id: ciphertext,
          result: ciphertext,
        })
      );
    });
    cm.on('status_changed', (status) => order.push(`status:${status}`));
    socket.emit('participants_changed', { event: 'join', clientType: 'wallet' });
    socket.emit('disconnected', 'transport close');
    order.length = 0;

    socket.emit('reconnected', {
      bufferedMessages: [
        { id: cm.getChannelId(), clientType: 'wallet', message: 'ciphertext-1' },
        { id: cm.getChannelId(), clientType: 'wallet', message: 'ciphertext-2' },
      ],
      channelPublicKey: null,
      participants: ['wallet'],
      terminated: false,
    });

    await vi.waitFor(() => {
      expect(cm.getStatus()).toBe(ConnectionStatus.CONNECTED);
    });
    expect(kex.decryptMessage.mock.calls.map(([ciphertext]) => ciphertext)).toEqual([
      'ciphertext-1',
      'ciphertext-2',
    ]);
    expect(order.filter((entry) => entry === 'persist')).toHaveLength(2);
    const connectedIndex = order.indexOf(`status:${ConnectionStatus.CONNECTED}`);
    expect(connectedIndex).toBeGreaterThan(order.lastIndexOf('persist'));
    await Promise.resolve();
    expect(kex.decryptMessage).toHaveBeenCalledTimes(2);
  });

  it('does not count a throwing consumer listener toward the teardown', async () => {
    const { cm, socket, kex } = await pairedManager();
    kex.decryptMessage
      .mockResolvedValueOnce(
        JSON.stringify({ jsonrpc: '2.0', type: 'jsonrpc', id: 'r-1', result: '0x1' })
      )
      .mockRejectedValueOnce(new Error('AEAD tag failed'));
    // A bug in the dApp's own event handler must not read as stream death.
    cm.on('jsonrpc_response', () => {
      throw new Error('consumer bug');
    });
    const terminated = vi.fn();
    cm.on('session_terminated', terminated);

    socket.emit('message', walletCiphertext(cm));
    socket.emit('message', walletCiphertext(cm));

    await vi.waitFor(() => {
      expect(kex.decryptMessage).toHaveBeenCalledTimes(2);
    });
    expect(socket.closeChannel).not.toHaveBeenCalled();
    expect(terminated).not.toHaveBeenCalled();
  });

  it('drops malformed JSON-RPC responses at the decrypted boundary', async () => {
    const { cm, socket, kex } = await pairedManager();
    kex.decryptMessage
      .mockResolvedValueOnce(JSON.stringify({ type: 'jsonrpc', id: 'a', result: 1 }))
      .mockResolvedValueOnce(
        JSON.stringify({ type: 'jsonrpc', jsonrpc: '2.0', id: 'b', result: 1, error: {} })
      )
      .mockResolvedValueOnce(JSON.stringify({ type: 'jsonrpc', jsonrpc: '2.0', id: 'c' }))
      .mockResolvedValueOnce(
        JSON.stringify({
          type: 'jsonrpc',
          jsonrpc: '2.0',
          id: 'd',
          error: { code: 1.5, message: 'fractional code' },
        })
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          type: 'jsonrpc',
          jsonrpc: '2.0',
          id: 'e',
          error: { code: -32000, message: 'x'.repeat(1025) },
        })
      )
      .mockResolvedValueOnce(
        JSON.stringify({ type: 'jsonrpc', jsonrpc: '2.0', id: 'ok', result: 'accepted' })
      );
    const responses = vi.fn();
    cm.on('jsonrpc_response', responses);

    for (let i = 0; i < 6; i++) socket.emit('message', walletCiphertext(cm));

    await vi.waitFor(() => {
      expect(kex.decryptMessage).toHaveBeenCalledTimes(6);
    });
    expect(responses).toHaveBeenCalledOnce();
    expect(responses).toHaveBeenCalledWith({ jsonrpc: '2.0', id: 'ok', result: 'accepted' });
  });

  it('fails closed before sending when the advanced counter cannot be persisted', async () => {
    installBrowserStorage({ failWrites: true });
    const { cm, socket, kex } = await pairedManager();
    kex.exportPersisted.mockResolvedValue(PERSISTED_KEX);

    await expect(
      cm.sendJsonRpc({ jsonrpc: '2.0', id: 'persist-fail', method: 'qrl_blockNumber' })
    ).rejects.toThrow('Failed to persist AEAD counters');

    expect(socket.sendMessage).not.toHaveBeenCalled();
    expect(socket.closeChannel).toHaveBeenCalledOnce();
    expect(cm.isPaired()).toBe(false);
  });

  it('retires the session when sealing fails after counter reservation', async () => {
    const { cm, socket, kex } = await pairedManager();
    kex.encryptMessage.mockRejectedValueOnce(new Error('WebCrypto seal failed'));

    await expect(
      cm.sendJsonRpc({ jsonrpc: '2.0', id: 'seal-fail', method: 'qrl_blockNumber' })
    ).rejects.toThrow('WebCrypto seal failed');

    expect(socket.sendMessage).not.toHaveBeenCalled();
    expect(socket.closeChannel).toHaveBeenCalledOnce();
    expect(cm.isPaired()).toBe(false);
  });

  it('rejects unbounded ids and method names at the final outbound boundary', async () => {
    const { cm, socket, kex } = await pairedManager();

    expect(() =>
      cm.sendJsonRpc({ jsonrpc: '2.0', id: 'x'.repeat(129), method: 'qrl_blockNumber' })
    ).toThrow('Invalid JSON-RPC request id');
    expect(() =>
      cm.sendJsonRpc({
        jsonrpc: '2.0',
        id: Number.MAX_SAFE_INTEGER + 1,
        method: 'qrl_blockNumber',
      })
    ).toThrow('Invalid JSON-RPC request id');
    expect(() => cm.sendJsonRpc({ jsonrpc: '2.0', id: 'valid', method: 'qrl method' })).toThrow(
      'Unsupported JSON-RPC method'
    );
    expect(() =>
      cm.sendJsonRpc({ jsonrpc: '2.0', id: 'valid', method: 'qrl_getTransactionByHash' })
    ).toThrow('Unsupported JSON-RPC method');

    expect(kex.encryptMessage).not.toHaveBeenCalled();
    expect(socket.sendMessage).not.toHaveBeenCalled();
  });

  it('tombstones the session when a relay send outcome is unknown', async () => {
    const { cm, socket } = await pairedManager();
    socket.sendMessage.mockRejectedValueOnce(new Error('relay acknowledgement timed out'));

    await expect(
      cm.sendJsonRpc({ jsonrpc: '2.0', id: 'ack-timeout', method: 'qrl_blockNumber' })
    ).rejects.toThrow('relay acknowledgement timed out');

    expect(socket.closeChannel).toHaveBeenCalledOnce();
    expect(cm.isPaired()).toBe(false);
    expect(cm.getStatus()).toBe(ConnectionStatus.DISCONNECTED);
  });

  it('does not let stalled work cross into a replacement session', async () => {
    const { cm, socket: oldSocket } = await pairedManager();
    let acknowledgeOld!: () => void;
    oldSocket.sendMessage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          acknowledgeOld = () => {
            resolve({ success: true, buffered: false });
          };
        })
    );

    const oldSend = cm.sendJsonRpc({
      jsonrpc: '2.0',
      id: 'old-request',
      method: 'qrl_blockNumber',
    });
    await vi.waitFor(() => {
      expect(oldSocket.sendMessage).toHaveBeenCalledOnce();
    });

    vi.useFakeTimers();
    try {
      const reset = cm.resetForNewChannel();
      await vi.advanceTimersByTimeAsync(TERMINATE_TEST_TIMEOUT_MS);
      await reset;
    } finally {
      vi.useRealTimers();
    }

    await cm.getConnectionURI();
    const replacementSocket = latestMockSocket;
    const replacementKex = latestMockKex;
    replacementKex.exchanged = true;

    await expect(
      cm.sendJsonRpc({
        jsonrpc: '2.0',
        id: 'replacement-request',
        method: 'qrl_blockNumber',
      })
    ).resolves.toBeUndefined();
    expect(replacementSocket.sendMessage).toHaveBeenCalledOnce();

    acknowledgeOld();
    await expect(oldSend).resolves.toBeUndefined();
    await Promise.resolve();
    await Promise.resolve();

    // The old queue also contained resetForNewChannel's TERMINATE. It must
    // fail its generation check instead of encrypting against the replacement.
    expect(replacementSocket.sendMessage).toHaveBeenCalledOnce();
  });

  it('drops queued messages and late events from a retired transport', async () => {
    const { cm, socket: oldSocket, kex: oldKex } = await pairedManager();
    let finishOldDecrypt!: () => void;
    oldKex.decryptMessage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOldDecrypt = () => {
            resolve(
              JSON.stringify({
                type: 'wallet_info',
                accounts: [ADDRESS_A],
              })
            );
          };
        })
    );

    oldSocket.emit('message', walletCiphertext(cm));
    oldSocket.emit('message', walletCiphertext(cm));
    await vi.waitFor(() => {
      expect(oldKex.decryptMessage).toHaveBeenCalledOnce();
    });

    await cm.resetForNewChannel();
    await cm.getConnectionURI();
    const replacementSocket = latestMockSocket;
    const replacementKex = latestMockKex;
    replacementKex.exchanged = true;
    replacementKex.decryptMessage.mockResolvedValue(
      JSON.stringify({
        type: 'wallet_info',
        accounts: [ADDRESS_B],
        chainId: '0x539',
      })
    );

    // An event already dispatched by the retired SocketClient must not be
    // allowed to tombstone the replacement pairing.
    oldSocket.emit('participants_changed', { event: 'close', clientType: 'wallet' });
    replacementSocket.emit('message', walletCiphertext(cm));
    await vi.waitFor(() => {
      expect(replacementKex.decryptMessage).toHaveBeenCalledOnce();
    });
    finishOldDecrypt();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(replacementKex.decryptMessage).toHaveBeenCalledOnce();
    expect(cm.isPaired()).toBe(true);
  });

  it('does not authorize or disclose accounts from fresh WALLET_INFO metadata', async () => {
    const { cm, socket, kex } = await pairedManager();
    kex.decryptMessage.mockResolvedValue(
      JSON.stringify({
        type: 'wallet_info',
        accounts: [ADDRESS_A],
        chainId: '0x539',
      })
    );
    const walletInfo = vi.fn();
    const accountsChanged = vi.fn();
    cm.on('wallet_info', walletInfo);
    cm.on('accounts_changed', accountsChanged);

    socket.emit('message', walletCiphertext(cm));
    await vi.waitFor(() => {
      expect(walletInfo).toHaveBeenCalledWith({ accounts: [], chainId: '0x539' });
    });
    expect(accountsChanged).not.toHaveBeenCalled();
    expect(cm.getAccounts()).toEqual([]);
  });

  it('persists approved accounts without exposing mutable internal references', async () => {
    const { cm } = await pairedManager();
    cm.on('accounts_changed', (accounts) => {
      accounts.length = 0;
    });

    await expect(cm.authorizeAccounts([ADDRESS_A])).resolves.toEqual([ADDRESS_A]);

    const returned = cm.getAccounts();
    returned[0] = ADDRESS_C;
    expect(cm.getAccounts()).toEqual([ADDRESS_A]);
  });

  it('rejects multi-account approval results at the session boundary', async () => {
    const { cm } = await pairedManager();

    await expect(cm.authorizeAccounts([ADDRESS_A, ADDRESS_B])).rejects.toThrow(
      'invalid account list'
    );
    expect(cm.getAccounts()).toEqual([]);
  });

  it('stores only accounts committed through the approval result boundary', async () => {
    const values = installBrowserStorage();
    const cm = new ConnectionManager({
      dappMetadata: { name: 'Account persistence', url: 'https://accounts.invalid' },
    });
    await cm.getConnectionURI();
    const kex = latestMockKex;
    kex.exchanged = true;
    kex.exportPersisted.mockResolvedValue(PERSISTED_KEX);

    const account = ADDRESS_A;
    await cm.authorizeAccounts([account]);

    const stored = JSON.parse(values.get('@qrlwallet/connect:session') ?? '{}') as {
      connectedAccounts?: unknown;
    };
    expect(stored.connectedAccounts).toEqual([account]);
    await cm.disconnect();
  });

  it('drops authenticated wallet info containing a malformed current-format address', async () => {
    const { cm, socket, kex } = await pairedManager();
    kex.decryptMessage.mockResolvedValue(
      JSON.stringify({ type: 'wallet_info', accounts: ['Q1234'], chainId: '0x539' })
    );
    const walletInfo = vi.fn();
    cm.on('wallet_info', walletInfo);

    socket.emit('message', walletCiphertext(cm));
    await vi.waitFor(() => {
      expect(kex.decryptMessage).toHaveBeenCalledOnce();
    });

    expect(walletInfo).not.toHaveBeenCalled();
    expect(cm.getAccounts()).toEqual([]);
  });

  it('drops wallet info from a legacy Q plus 40 peer', async () => {
    const { cm, socket, kex } = await pairedManager();
    kex.decryptMessage.mockResolvedValue(
      JSON.stringify({
        type: 'wallet_info',
        accounts: [`Q${'a'.repeat(40)}`],
        chainId: '0x539',
      })
    );
    const walletInfo = vi.fn();
    cm.on('wallet_info', walletInfo);

    socket.emit('message', walletCiphertext(cm));
    await vi.waitFor(() => {
      expect(kex.decryptMessage).toHaveBeenCalledOnce();
    });

    expect(walletInfo).not.toHaveBeenCalled();
    expect(cm.getAccounts()).toEqual([]);
  });

  it('drops authenticated wallet info containing a non-canonical chain id', async () => {
    const { cm, socket, kex } = await pairedManager();
    kex.decryptMessage.mockResolvedValue(
      JSON.stringify({ type: 'wallet_info', accounts: [], chainId: '0x0539' })
    );
    const walletInfo = vi.fn();
    cm.on('wallet_info', walletInfo);

    socket.emit('message', walletCiphertext(cm));
    await vi.waitFor(() => {
      expect(kex.decryptMessage).toHaveBeenCalledOnce();
    });

    expect(walletInfo).not.toHaveBeenCalled();
    expect(cm.getChainId()).toBe('0x0');
  });

  it('does not revive a restore that was cancelled during key hydration', async () => {
    const values = installBrowserStorage();
    values.set('@qrlwallet/connect:session', storedSession());
    const hydrate = vi.mocked(
      (await import('../src/KeyExchange.js')).KeyExchange.sessionFromPersisted
    );
    let finishHydration!: () => void;
    hydrate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishHydration = () => {
            resolve(undefined as never);
          };
        })
    );
    const cm = new ConnectionManager({
      dappMetadata: { name: 'Cancelled restore', url: 'https://restore.invalid' },
    });

    const reconnect = cm.reconnect();
    await vi.waitFor(() => {
      expect(hydrate).toHaveBeenCalledOnce();
    });
    await cm.disconnect();
    finishHydration();

    await expect(reconnect).resolves.toBe(false);
    expect(latestMockSocket.joinChannel).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111'
    );
    expect(latestMockSocket.closeChannel).toHaveBeenCalledOnce();
    expect(cm.isPaired()).toBe(false);
  });

  it('does not acquire or reconnect after disconnect cancels a pending Web Lock request', async () => {
    const locks = deferredLockManager();
    const values = installBrowserStorage({ lockManager: locks.manager });
    values.set('@qrlwallet/connect:session', storedSession());
    const hydrate = vi.mocked(
      (await import('../src/KeyExchange.js')).KeyExchange.sessionFromPersisted
    );
    const cm = new ConnectionManager({
      dappMetadata: { name: 'Pending ownership', url: 'https://ownership.invalid' },
    });

    const reconnect = cm.reconnect();
    const disconnect = cm.disconnect();
    // Let disconnect() retire the cold relay channel and advance into
    // release() before the browser dispatches the deferred Web Locks callback.
    await Promise.resolve();
    const dispatch = locks.dispatch();

    await expect(disconnect).resolves.toBeUndefined();
    await dispatch;
    await expect(reconnect).resolves.toBe(false);
    expect(hydrate).not.toHaveBeenCalled();
    expect(latestMockSocket.joinChannel).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111'
    );
    expect(latestMockSocket.closeChannel).toHaveBeenCalledOnce();
    expect(cm.isPaired()).toBe(false);
  });

  it('does not let a stale restore release ownership from a concurrent fresh pairing', async () => {
    const locks = deferredLockManager();
    const values = installBrowserStorage({ lockManager: locks.manager });
    values.set('@qrlwallet/connect:session', storedSession());
    const hydrate = vi.mocked(
      (await import('../src/KeyExchange.js')).KeyExchange.sessionFromPersisted
    );
    const cm = new ConnectionManager({
      dappMetadata: { name: 'Fresh pairing', url: 'https://fresh.invalid' },
    });

    const staleReconnect = cm.reconnect();
    await cm.resetForNewChannel();
    const freshUri = cm.getConnectionURI();
    const dispatch = locks.dispatch();

    await expect(staleReconnect).resolves.toBe(false);
    await expect(freshUri).resolves.toMatch(/^qrlconnect:/);
    expect(hydrate).not.toHaveBeenCalled();

    const freshKex = latestMockKex;
    const freshSocket = latestMockSocket;
    freshKex.exchanged = true;
    freshKex.exportPersisted.mockResolvedValue(PERSISTED_KEX);
    await expect(
      cm.sendJsonRpc({ jsonrpc: '2.0', id: 'fresh', method: 'qrl_blockNumber' })
    ).resolves.toBeUndefined();
    expect(freshSocket.closeChannel).not.toHaveBeenCalled();

    await cm.disconnect();
    await dispatch;
  });

  it('does not dispatch decrypted plaintext when the receive counter cannot be persisted', async () => {
    installBrowserStorage({ failWrites: true });
    const { cm, socket, kex } = await pairedManager();
    kex.exportPersisted.mockResolvedValue(PERSISTED_KEX);
    kex.decryptMessage.mockResolvedValue(
      JSON.stringify({
        type: 'wallet_info',
        accounts: [ADDRESS_1],
        chainId: '0x539',
      })
    );
    const walletInfo = vi.fn();
    cm.on('wallet_info', walletInfo);

    socket.emit('message', walletCiphertext(cm));

    await vi.waitFor(() => {
      expect(socket.closeChannel).toHaveBeenCalledOnce();
    });
    expect(walletInfo).not.toHaveBeenCalled();
    expect(cm.isPaired()).toBe(false);
  });

  it('allows only one tab to own and restore a persisted counter stream', async () => {
    const values = installBrowserStorage();
    values.set('@qrlwallet/connect:session', storedSession());

    const first = new ConnectionManager({
      dappMetadata: { name: 'First', url: 'https://first.invalid' },
    });
    const second = new ConnectionManager({
      dappMetadata: { name: 'Second', url: 'https://second.invalid' },
    });

    await expect(first.reconnect()).resolves.toBe(true);
    await expect(second.reconnect()).resolves.toBe(false);

    await first.disconnect();
    await second.disconnect();
  });

  it('refreshes counters from storage only after acquiring tab ownership', async () => {
    const values = installBrowserStorage();
    values.set('@qrlwallet/connect:session', storedSession(4));
    const cm = new ConnectionManager({
      dappMetadata: { name: 'Refresh', url: 'https://refresh.invalid' },
    });

    values.set('@qrlwallet/connect:session', storedSession(19));
    await expect(cm.reconnect()).resolves.toBe(true);

    const hydrate = vi.mocked(
      (await import('../src/KeyExchange.js')).KeyExchange.sessionFromPersisted
    );
    expect(hydrate).toHaveBeenCalledWith(expect.objectContaining({ sendSeq: 19 }));
    await cm.disconnect();
  });

  it('keeps an established restore and its ownership across redundant reconnect calls', async () => {
    const locks = fakeLockManager();
    const storageOptions = {
      failReads: false,
      failWrites: false,
      failRemoves: false,
      lockManager: locks,
    };
    const values = installBrowserStorage(storageOptions);
    values.set('@qrlwallet/connect:session', storedSession());
    const hydrate = vi.mocked(
      (await import('../src/KeyExchange.js')).KeyExchange.sessionFromPersisted
    );
    const first = new ConnectionManager({
      dappMetadata: { name: 'Idempotent restore', url: 'https://idempotent.invalid' },
    });

    await expect(first.reconnect()).resolves.toBe(true);
    const firstKex = latestMockKex;
    firstKex.exchanged = true;
    firstKex.exportPersisted.mockResolvedValue(PERSISTED_KEX);
    storageOptions.failReads = true;

    await expect(first.reconnect()).resolves.toBe(true);
    expect(hydrate).toHaveBeenCalledOnce();

    storageOptions.failReads = false;
    const second = new ConnectionManager({
      dappMetadata: { name: 'Blocked duplicate', url: 'https://duplicate.invalid' },
    });
    await expect(second.reconnect()).resolves.toBe(false);

    await first.disconnect();
    await second.disconnect();
  });

  it('retains ownership when hydration and stored-session invalidation both fail', async () => {
    const locks = fakeLockManager();
    const storageOptions = {
      failReads: false,
      failWrites: false,
      failRemoves: false,
      lockManager: locks,
    };
    const values = installBrowserStorage(storageOptions);
    values.set('@qrlwallet/connect:session', storedSession());
    const hydrate = vi.mocked(
      (await import('../src/KeyExchange.js')).KeyExchange.sessionFromPersisted
    );
    hydrate.mockRejectedValueOnce(new Error('key import failed'));
    const first = new ConnectionManager({
      dappMetadata: { name: 'Hydration failure', url: 'https://hydrate.invalid' },
    });
    const error = vi.fn();
    first.on('error', error);
    storageOptions.failWrites = true;
    storageOptions.failRemoves = true;

    await expect(first.reconnect()).resolves.toBe(false);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Unable to invalidate stored session; retaining browser-tab ownership',
      })
    );

    const second = new ConnectionManager({
      dappMetadata: { name: 'Blocked hydration restore', url: 'https://blocked-hydrate.invalid' },
    });
    await expect(second.reconnect()).resolves.toBe(false);

    storageOptions.failWrites = false;
    storageOptions.failRemoves = false;
    await first.disconnect();
    await second.disconnect();
  });

  it('retains ownership when refresh read and invalidation both fail', async () => {
    const locks = fakeLockManager();
    const storageOptions = {
      failReads: false,
      failWrites: false,
      failRemoves: false,
      lockManager: locks,
    };
    const values = installBrowserStorage(storageOptions);
    values.set('@qrlwallet/connect:session', storedSession());
    const first = new ConnectionManager({
      dappMetadata: { name: 'Refresh failure', url: 'https://refresh-failure.invalid' },
    });
    const error = vi.fn();
    first.on('error', error);
    storageOptions.failReads = true;
    storageOptions.failWrites = true;
    storageOptions.failRemoves = true;

    await expect(first.reconnect()).resolves.toBe(false);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Unable to invalidate stored session; retaining browser-tab ownership',
      })
    );

    storageOptions.failReads = false;
    const second = new ConnectionManager({
      dappMetadata: { name: 'Blocked refresh restore', url: 'https://blocked-refresh.invalid' },
    });
    await expect(second.reconnect()).resolves.toBe(false);

    storageOptions.failWrites = false;
    storageOptions.failRemoves = false;
    await first.disconnect();
    await second.disconnect();
  });

  it('drops pre-PQP3 version 4 sessions instead of restoring their keys', async () => {
    const values = installBrowserStorage();
    const legacy = JSON.parse(storedSession()) as Record<string, unknown>;
    legacy.version = 4;
    values.set('@qrlwallet/connect:session', JSON.stringify(legacy));

    const cm = new ConnectionManager({
      dappMetadata: { name: 'Migration', url: 'https://migration.invalid' },
    });

    expect(cm.hasStoredSession()).toBe(false);
    expect(values.has('@qrlwallet/connect:session')).toBe(false);
    await cm.disconnect();
  });

  it('drops a version 5 record whose inner key exchange predates protocol v3', async () => {
    const values = installBrowserStorage();
    const legacy = JSON.parse(storedSession()) as {
      keyExchange: Record<string, unknown>;
    };
    legacy.keyExchange.protocolVersion = 2;
    values.set('@qrlwallet/connect:session', JSON.stringify(legacy));

    const cm = new ConnectionManager({
      dappMetadata: { name: 'Inner migration', url: 'https://inner-migration.invalid' },
    });

    expect(cm.hasStoredSession()).toBe(false);
    expect(values.has('@qrlwallet/connect:session')).toBe(false);
    await cm.disconnect();
  });

  it('drops persisted sessions whose base64 fields do not have exact decoded widths', async () => {
    const fields = ['cid', 'kAeadRaw', 'htx', 'sendDir', 'recvDir'] as const;
    for (const field of fields) {
      const values = installBrowserStorage();
      const malformed = JSON.parse(storedSession()) as {
        keyExchange: Record<string, unknown>;
      };
      malformed.keyExchange[field] = 'AA==';
      values.set('@qrlwallet/connect:session', JSON.stringify(malformed));

      const cm = new ConnectionManager({
        dappMetadata: { name: `Malformed ${field}`, url: 'https://base64.invalid' },
      });
      expect(cm.hasStoredSession()).toBe(false);
      expect(values.has('@qrlwallet/connect:session')).toBe(false);
      await cm.disconnect();
    }
  });

  it('drops poisoned stored metadata, chain ids, and timestamps', async () => {
    const poisoners: ((session: Record<string, unknown>) => void)[] = [
      (session) => {
        const metadata = session.dappMetadata as Record<string, unknown>;
        metadata.name = 'x'.repeat(129);
      },
      (session) => {
        const metadata = session.dappMetadata as Record<string, unknown>;
        metadata.url = 'javascript:alert(1)';
      },
      (session) => {
        session.chainId = '0x0539';
      },
      (session) => {
        session.createdAt = Date.now() + 10 * 60 * 1000;
        session.lastActivity = session.createdAt;
      },
      (session) => {
        session.lastActivity = 1;
      },
      (session) => {
        session.connectedAccounts = [ADDRESS_A, ADDRESS_B];
      },
    ];

    for (const poison of poisoners) {
      const values = installBrowserStorage();
      const session = JSON.parse(storedSession()) as Record<string, unknown>;
      poison(session);
      values.set('@qrlwallet/connect:session', JSON.stringify(session));

      const cm = new ConnectionManager({
        dappMetadata: { name: 'Poisoned storage', url: 'https://poisoned.invalid' },
      });
      expect(cm.hasStoredSession()).toBe(false);
      expect(values.has('@qrlwallet/connect:session')).toBe(false);
      await cm.disconnect();
    }
  });

  it('drops a persisted session whose numeric counter cannot advance safely', async () => {
    const values = installBrowserStorage();
    values.set('@qrlwallet/connect:session', storedSession(Number.MAX_SAFE_INTEGER));

    const cm = new ConnectionManager({
      dappMetadata: { name: 'Counter validation', url: 'https://counter.invalid' },
    });

    expect(cm.hasStoredSession()).toBe(false);
    expect(values.has('@qrlwallet/connect:session')).toBe(false);
    await cm.disconnect();
  });

  it.each([
    ['malformed', 'Q1234'],
    ['legacy Q plus 40', `Q${'a'.repeat(40)}`],
  ])('drops a persisted session containing a %s account', async (_label, account) => {
    const values = installBrowserStorage();
    const malformed = JSON.parse(storedSession()) as Record<string, unknown>;
    malformed.connectedAccounts = [account];
    values.set('@qrlwallet/connect:session', JSON.stringify(malformed));

    const cm = new ConnectionManager({
      dappMetadata: { name: 'Address validation', url: 'https://address.invalid' },
    });

    expect(cm.hasStoredSession()).toBe(false);
    expect(values.has('@qrlwallet/connect:session')).toBe(false);
    await cm.disconnect();
  });

  it('invalidates a stored session by overwrite when removal is unavailable', async () => {
    const storageOptions = { failRemoves: false, failWrites: false };
    const values = installBrowserStorage(storageOptions);
    const cm = new ConnectionManager({
      dappMetadata: { name: 'Overwrite fallback', url: 'https://overwrite.invalid' },
    });
    await cm.getConnectionURI();
    const socket = latestMockSocket;
    socket.closeChannel.mockResolvedValue(true);
    values.set('@qrlwallet/connect:session', storedSession());
    storageOptions.failRemoves = true;

    await expect(cm.disconnect()).resolves.toBeUndefined();
    expect(values.get('@qrlwallet/connect:session')).toBe('{"version":0}');
  });

  it('retains tab ownership when neither storage nor relay can retire the session', async () => {
    const locks = fakeLockManager();
    const storageOptions = {
      failRemoves: false,
      failWrites: false,
      lockManager: locks,
    };
    const values = installBrowserStorage(storageOptions);
    const first = new ConnectionManager({
      dappMetadata: { name: 'Retirement failure', url: 'https://retirement.invalid' },
    });
    await first.getConnectionURI();
    const firstSocket = latestMockSocket;
    firstSocket.closeChannel.mockResolvedValue(false);
    values.set('@qrlwallet/connect:session', storedSession());
    storageOptions.failRemoves = true;
    storageOptions.failWrites = true;

    await expect(first.disconnect()).rejects.toThrow('Unable to retire the relay channel');

    const second = new ConnectionManager({
      dappMetadata: { name: 'Second tab', url: 'https://second-tab.invalid' },
    });
    await expect(second.reconnect()).resolves.toBe(false);

    // Restore storage only for deterministic cleanup of the retained lock.
    storageOptions.failRemoves = false;
    storageOptions.failWrites = false;
    firstSocket.closeChannel.mockResolvedValue(true);
    await first.disconnect();
    await second.disconnect();
  });

  it('retains tab ownership when fresh URI rotation cannot invalidate storage', async () => {
    const locks = fakeLockManager();
    const storageOptions = {
      failRemoves: false,
      failWrites: false,
      lockManager: locks,
    };
    const values = installBrowserStorage(storageOptions);
    const first = new ConnectionManager({
      dappMetadata: { name: 'Failed rotation', url: 'https://rotation.invalid' },
    });
    await first.getConnectionURI();
    values.set('@qrlwallet/connect:session', storedSession());
    storageOptions.failRemoves = true;
    storageOptions.failWrites = true;

    await expect(first.getConnectionURI()).rejects.toThrow(
      'Unable to invalidate stored session; retaining browser-tab ownership'
    );

    const second = new ConnectionManager({
      dappMetadata: { name: 'Blocked second tab', url: 'https://blocked.invalid' },
    });
    await expect(second.reconnect()).resolves.toBe(false);

    storageOptions.failRemoves = false;
    storageOptions.failWrites = false;
    await first.disconnect();
    await second.disconnect();
  });

  it('rejects disconnect and retains ownership despite a confirmed relay close', async () => {
    const locks = fakeLockManager();
    const storageOptions = {
      failRemoves: false,
      failWrites: false,
      lockManager: locks,
    };
    const values = installBrowserStorage(storageOptions);
    const first = new ConnectionManager({
      dappMetadata: { name: 'Confirmed disconnect', url: 'https://disconnect-close.invalid' },
    });
    await first.getConnectionURI();
    const socket = latestMockSocket;
    socket.closeChannel.mockResolvedValue(true);
    values.set('@qrlwallet/connect:session', storedSession());
    storageOptions.failRemoves = true;
    storageOptions.failWrites = true;

    await expect(first.disconnect()).rejects.toThrow(
      'Unable to invalidate stored session; retaining browser-tab ownership'
    );
    expect(socket.closeChannel).toHaveBeenCalledOnce();

    const second = new ConnectionManager({
      dappMetadata: { name: 'Blocked restore', url: 'https://blocked-restore.invalid' },
    });
    await expect(second.reconnect()).resolves.toBe(false);

    storageOptions.failRemoves = false;
    storageOptions.failWrites = false;
    await first.disconnect();
    await second.disconnect();
  });

  it('rejects reset when storage invalidation fails after a confirmed relay close', async () => {
    const storageOptions = { failRemoves: false, failWrites: false };
    const values = installBrowserStorage(storageOptions);
    const cm = new ConnectionManager({
      dappMetadata: { name: 'Confirmed reset', url: 'https://reset-close.invalid' },
    });
    await cm.getConnectionURI();
    const socket = latestMockSocket;
    socket.closeChannel.mockResolvedValue(true);
    values.set('@qrlwallet/connect:session', storedSession());
    storageOptions.failRemoves = true;
    storageOptions.failWrites = true;

    await expect(cm.resetForNewChannel()).rejects.toThrow(
      'Unable to invalidate stored session; retaining browser-tab ownership'
    );
    expect(socket.closeChannel).toHaveBeenCalledOnce();

    storageOptions.failRemoves = false;
    storageOptions.failWrites = false;
    await cm.disconnect();
  });

  it('retains ownership after terminal relay evidence when storage invalidation fails', async () => {
    const locks = fakeLockManager();
    const storageOptions = {
      failRemoves: false,
      failWrites: false,
      lockManager: locks,
    };
    const values = installBrowserStorage(storageOptions);
    const first = new ConnectionManager({
      dappMetadata: { name: 'Terminal evidence', url: 'https://terminal.invalid' },
    });
    await first.getConnectionURI();
    const socket = latestMockSocket;
    values.set('@qrlwallet/connect:session', storedSession());
    storageOptions.failRemoves = true;
    storageOptions.failWrites = true;
    const error = vi.fn();
    first.on('error', error);

    socket.emit('participants_changed', { event: 'close', clientType: 'wallet' });

    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Unable to invalidate stored session; retaining browser-tab ownership',
      })
    );
    expect(first.getStatus()).toBe(ConnectionStatus.DISCONNECTED);

    const second = new ConnectionManager({
      dappMetadata: { name: 'Blocked terminal restore', url: 'https://blocked-terminal.invalid' },
    });
    await expect(second.reconnect()).resolves.toBe(false);

    storageOptions.failRemoves = false;
    storageOptions.failWrites = false;
    await first.disconnect();
    await second.disconnect();
  });
});
