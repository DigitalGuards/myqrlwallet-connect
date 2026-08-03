import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import EventEmitter from 'eventemitter3';
import { ConnectionStatus, KeyExchangeMessageType } from '../src/types.js';

// Track latest mock instances (same pattern as QRLConnectProvider.test.ts)
let latestMockSocket: MockSocketClient;
let latestMockKex: MockKeyExchange;
let nextJoinError: Error | null = null;
const TERMINATE_TEST_TIMEOUT_MS = 801;

const PERSISTED_KEX = {
  cid: 'AA==',
  kAeadRaw: 'AA==',
  htx: 'AA==',
  sendDir: 'AA==',
  recvDir: 'AA==',
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
    version: 4,
    channelId: '11111111-1111-4111-8111-111111111111',
    keyExchange: { ...PERSISTED_KEX, sendSeq },
    dappMetadata: { name: 'Stored dApp', url: 'https://stored.invalid' },
    connectedAccounts: ['Qaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
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

  initiate = vi.fn(() => new Uint8Array(1184));
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
}

vi.mock('../src/SocketClient.js', () => ({
  SocketClient: vi.fn().mockImplementation(() => new MockSocketClient()),
}));

vi.mock('../src/KeyExchange.js', () => ({
  KeyExchange: Object.assign(
    vi.fn().mockImplementation(() => new MockKeyExchange()),
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

describe('ConnectionManager desync teardown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nextJoinError = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
        ct: 'AA==',
        c0: 'AA==',
        v: 2,
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

  it('resets the failure counter on a successful decrypt', async () => {
    const { cm, socket, kex } = await pairedManager();
    kex.decryptMessage
      .mockRejectedValueOnce(new Error('AEAD tag failed'))
      .mockResolvedValueOnce(
        JSON.stringify({
          type: 'wallet_info',
          accounts: ['Q1111111111111111111111111111111111111111'],
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
                accounts: ['Qaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
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
        accounts: ['Qbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
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

  it('does not expose mutable references to authenticated account state', async () => {
    const { cm, socket, kex } = await pairedManager();
    kex.decryptMessage.mockResolvedValue(
      JSON.stringify({
        type: 'wallet_info',
        accounts: ['Qaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
        chainId: '0x539',
      })
    );
    cm.on('wallet_info', (info) => {
      info.accounts[0] = 'Qbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    });
    cm.on('accounts_changed', (accounts) => {
      accounts.length = 0;
    });

    socket.emit('message', walletCiphertext(cm));
    await vi.waitFor(() => {
      expect(cm.getAccounts()).toEqual(['Qaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
    });

    const returned = cm.getAccounts();
    returned[0] = 'Qcccccccccccccccccccccccccccccccccccccccc';
    expect(cm.getAccounts()).toEqual(['Qaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
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
    expect(latestMockSocket.joinChannel).not.toHaveBeenCalled();
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
    // Let disconnect() advance past flushTerminate() into release() before the
    // browser dispatches the deferred Web Locks callback.
    await Promise.resolve();
    const dispatch = locks.dispatch();

    await expect(disconnect).resolves.toBeUndefined();
    await dispatch;
    await expect(reconnect).resolves.toBe(false);
    expect(hydrate).not.toHaveBeenCalled();
    expect(latestMockSocket.joinChannel).not.toHaveBeenCalled();
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
        accounts: ['Q1111111111111111111111111111111111111111'],
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

  it('drops pre-ownership v3 sessions instead of trusting their counters', async () => {
    const values = installBrowserStorage();
    const legacy = JSON.parse(storedSession()) as Record<string, unknown>;
    legacy.version = 3;
    values.set('@qrlwallet/connect:session', JSON.stringify(legacy));

    const cm = new ConnectionManager({
      dappMetadata: { name: 'Migration', url: 'https://migration.invalid' },
    });

    expect(cm.hasStoredSession()).toBe(false);
    expect(values.has('@qrlwallet/connect:session')).toBe(false);
    await cm.disconnect();
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

  it('drops a persisted session containing a malformed current-format account', async () => {
    const values = installBrowserStorage();
    const malformed = JSON.parse(storedSession()) as Record<string, unknown>;
    malformed.connectedAccounts = ['Q1234'];
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
    socket.closeChannel.mockResolvedValue(false);
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
    latestMockSocket.closeChannel.mockResolvedValue(false);
    values.set('@qrlwallet/connect:session', storedSession());
    storageOptions.failRemoves = true;
    storageOptions.failWrites = true;

    await expect(first.disconnect()).rejects.toThrow(
      'Unable to invalidate stored session; retaining browser-tab ownership'
    );

    const second = new ConnectionManager({
      dappMetadata: { name: 'Second tab', url: 'https://second-tab.invalid' },
    });
    await expect(second.reconnect()).resolves.toBe(false);

    // Restore storage only for deterministic cleanup of the retained lock.
    storageOptions.failRemoves = false;
    storageOptions.failWrites = false;
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
      'Unable to clear the previous persisted AEAD session'
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
