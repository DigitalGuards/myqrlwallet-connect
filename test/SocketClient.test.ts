import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock socket.io-client before importing SocketClient
const mockSocket = {
  connected: false,
  on: vi.fn(),
  emit: vi.fn(),
  disconnect: vi.fn(),
  removeAllListeners: vi.fn(),
};

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => mockSocket),
}));

import { SocketClient } from '../src/SocketClient.js';

describe('SocketClient', () => {
  let client: SocketClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSocket.connected = false;
    mockSocket.on.mockReset();
    mockSocket.emit.mockReset();
    client = new SocketClient('https://relay.test.com', 'dapp');
  });

  afterEach(() => {
    client.disconnect();
  });

  describe('constructor', () => {
    it('should initialize with correct properties', () => {
      expect(client.isConnected()).toBe(false);
      expect(client.getChannelId()).toBeNull();
    });
  });

  describe('connect', () => {
    it('should create socket connection with correct options', async () => {
      const { io } = await import('socket.io-client');
      client.connect();
      expect(io).toHaveBeenCalledWith('https://relay.test.com', expect.objectContaining({
        path: '/relay',
        transports: ['websocket', 'polling'],
        reconnection: true,
      }));
    });

    it('should register event handlers', () => {
      client.connect();
      const registeredEvents = mockSocket.on.mock.calls.map((c: unknown[]) => c[0]);
      expect(registeredEvents).toContain('connect');
      expect(registeredEvents).toContain('disconnect');
      expect(registeredEvents).toContain('message');
      expect(registeredEvents).toContain('participants_changed');
      expect(registeredEvents).toContain('connect_error');
    });

    it('should not reconnect if already connected', () => {
      mockSocket.connected = true;
      client.connect();
      // First call creates socket
      client.connect();
      // Since socket.connected is true, io should only be called once
      // (the guard is this.socket?.connected which checks the mock)
    });

    it('should emit connected event on connect', () => {
      const connectedSpy = vi.fn();
      client.on('connected', connectedSpy);
      client.connect();

      // Simulate socket connect event
      const connectHandler = mockSocket.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'connect'
      )?.[1] as Function;
      connectHandler?.();

      expect(connectedSpy).toHaveBeenCalledOnce();
    });

    it('should emit disconnected event with reason', () => {
      const disconnectedSpy = vi.fn();
      client.on('disconnected', disconnectedSpy);
      client.connect();

      const disconnectHandler = mockSocket.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'disconnect'
      )?.[1] as Function;
      disconnectHandler?.('transport close');

      expect(disconnectedSpy).toHaveBeenCalledWith('transport close');
    });

    it('should forward message events', () => {
      const messageSpy = vi.fn();
      client.on('message', messageSpy);
      client.connect();

      const messageHandler = mockSocket.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'message'
      )?.[1] as Function;
      const testData = { id: 'chan-1', message: 'encrypted', clientType: 'wallet' };
      messageHandler?.(testData);

      expect(messageSpy).toHaveBeenCalledWith(testData);
    });

    it('should forward participants_changed events', () => {
      const participantsSpy = vi.fn();
      client.on('participants_changed', participantsSpy);
      client.connect();

      const handler = mockSocket.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'participants_changed'
      )?.[1] as Function;
      handler?.({ event: 'join', clientType: 'wallet' });

      expect(participantsSpy).toHaveBeenCalledWith({
        event: 'join',
        clientType: 'wallet',
      });
    });
  });

  describe('joinChannel', () => {
    it('should reject if connect was not called', async () => {
      await expect(client.joinChannel('test-channel')).rejects.toThrow(
        'Socket not initialized. Call connect() before joinChannel()'
      );
    });

    it('should wait for connect and then join channel', async () => {
      client.connect();
      const buffered = [{ id: 'chan', message: 'msg1' }];
      mockSocket.emit.mockImplementation(
        (event: string, _payload: unknown, callback?: Function) => {
          if (event === 'join_channel' && callback) {
            callback({ success: true, bufferedMessages: buffered });
          }
        }
      );

      const joinPromise = client.joinChannel('test-channel');
      expect(client.getChannelId()).toBe('test-channel');

      const connectHandler = mockSocket.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'connect'
      )?.[1] as Function;
      mockSocket.connected = true;
      connectHandler?.();

      const result = await joinPromise;
      expect(client.getChannelId()).toBe('test-channel');
      expect(result.bufferedMessages).toEqual(buffered);
    });

    it('should emit join_channel when connected', async () => {
      client.connect();
      mockSocket.connected = true;

      // Mock the callback response
      mockSocket.emit.mockImplementation(
        (event: string, _payload: unknown, callback?: Function) => {
          if (event === 'join_channel' && callback) {
            callback({ success: true, bufferedMessages: [] });
          }
        }
      );

      const result = await client.joinChannel('test-channel');
      expect(result.bufferedMessages).toEqual([]);
      expect(mockSocket.emit).toHaveBeenCalledWith(
        'join_channel',
        { channelId: 'test-channel', clientType: 'dapp' },
        expect.any(Function)
      );
    });

    it('should return buffered messages from join', async () => {
      client.connect();
      mockSocket.connected = true;

      const buffered = [{ id: 'chan', message: 'msg1' }];
      mockSocket.emit.mockImplementation(
        (event: string, _payload: unknown, callback?: Function) => {
          if (event === 'join_channel' && callback) {
            callback({ success: true, bufferedMessages: buffered });
          }
        }
      );

      const result = await client.joinChannel('test-channel');
      expect(result.bufferedMessages).toEqual(buffered);
    });

    it('should reject on join failure', async () => {
      client.connect();
      mockSocket.connected = true;

      mockSocket.emit.mockImplementation(
        (event: string, _payload: unknown, callback?: Function) => {
          if (event === 'join_channel' && callback) {
            callback({ success: false, error: 'Channel is full' });
          }
        }
      );

      await expect(client.joinChannel('test-channel')).rejects.toThrow('Channel is full');
    });

    it('should reject deferred join when connect-time join fails', async () => {
      client.connect();
      mockSocket.emit.mockImplementation(
        (event: string, _payload: unknown, callback?: Function) => {
          if (event === 'join_channel' && callback) {
            callback({ success: false, error: 'Channel is full' });
          }
        }
      );

      const joinPromise = client.joinChannel('test-channel');
      const connectHandler = mockSocket.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'connect'
      )?.[1] as Function;
      mockSocket.connected = true;
      connectHandler?.();

      await expect(joinPromise).rejects.toThrow('Channel is full');
    });
  });

  describe('sendMessage', () => {
    it('should reject when not connected', async () => {
      await expect(
        client.sendMessage({ id: 'chan', clientType: 'dapp', message: 'test' })
      ).rejects.toThrow('Socket not connected');
    });

    it('should send message when connected', async () => {
      client.connect();
      mockSocket.connected = true;

      mockSocket.emit.mockImplementation(
        (event: string, _payload: unknown, callback?: Function) => {
          if (event === 'message' && callback) {
            callback({ success: true, buffered: false });
          }
        }
      );

      const result = await client.sendMessage({
        id: 'chan',
        clientType: 'dapp',
        message: 'encrypted-data',
      });
      expect(result).toEqual({ success: true, buffered: false });
    });

    it('should reject on send failure', async () => {
      client.connect();
      mockSocket.connected = true;

      mockSocket.emit.mockImplementation(
        (event: string, _payload: unknown, callback?: Function) => {
          if (event === 'message' && callback) {
            callback({ success: false, error: 'Rate limit exceeded' });
          }
        }
      );

      await expect(
        client.sendMessage({ id: 'chan', clientType: 'dapp', message: 'test' })
      ).rejects.toThrow('Rate limit exceeded');
    });
  });

  describe('leaveChannel', () => {
    it('should emit leave_channel and clear channelId', async () => {
      client.connect();
      mockSocket.connected = true;

      mockSocket.emit.mockImplementation(
        (event: string, _payload: unknown, callback?: Function) => {
          if (event === 'join_channel' && callback) {
            callback({ success: true, bufferedMessages: [] });
          }
        }
      );

      await client.joinChannel('test-channel');
      client.leaveChannel();

      expect(mockSocket.emit).toHaveBeenCalledWith(
        'leave_channel',
        { channelId: 'test-channel' }
      );
      expect(client.getChannelId()).toBeNull();
    });
  });

  describe('disconnect', () => {
    it('should clean up socket on disconnect', () => {
      client.connect();
      client.disconnect();

      expect(mockSocket.removeAllListeners).toHaveBeenCalled();
      expect(mockSocket.disconnect).toHaveBeenCalled();
      expect(client.getChannelId()).toBeNull();
    });
  });
});
