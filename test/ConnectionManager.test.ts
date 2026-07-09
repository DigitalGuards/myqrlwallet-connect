import { describe, it, expect, vi, beforeEach } from 'vitest';
import EventEmitter from 'eventemitter3';
import { ConnectionStatus } from '../src/types.js';

// Track latest mock instances (same pattern as QRLConnectProvider.test.ts)
let latestMockSocket: MockSocketClient;
let latestMockKex: MockKeyExchange;

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
    return Promise.resolve();
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

  it('resets the failure counter on a successful decrypt', async () => {
    const { cm, socket, kex } = await pairedManager();
    kex.decryptMessage
      .mockRejectedValueOnce(new Error('AEAD tag failed'))
      .mockResolvedValueOnce(
        JSON.stringify({ type: 'wallet_info', accounts: ['Q1'], chainId: '0x1' })
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
});
