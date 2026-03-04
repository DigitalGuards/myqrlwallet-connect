/**
 * Socket.IO client wrapper for relay communication.
 */

import { io, Socket } from 'socket.io-client';
import EventEmitter from 'eventemitter3';
import { RELAY_PATH } from './config.js';
import { log, warn, error as logError } from './utils/logger.js';
import type { RelayMessage } from './types.js';

interface SocketClientEvents {
  message: (data: RelayMessage) => void;
  connected: () => void;
  disconnected: (reason: string) => void;
  reconnected: () => void;
  participants_changed: (data: { event: string; clientType?: string }) => void;
  error: (err: Error) => void;
}

export class SocketClient extends EventEmitter<SocketClientEvents> {
  private socket: Socket | null = null;
  private relayUrl: string;
  private channelId: string | null = null;
  private clientType: 'dapp' | 'wallet';

  constructor(relayUrl: string, clientType: 'dapp' | 'wallet') {
    super();
    this.relayUrl = relayUrl;
    this.clientType = clientType;
  }

  /**
   * Connect to the relay server.
   */
  connect(): void {
    if (this.socket?.connected) return;

    log('Socket', `Connecting to ${this.relayUrl}`);

    this.socket = io(this.relayUrl, {
      path: RELAY_PATH,
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30000,
      reconnectionAttempts: Infinity,
      timeout: 20000,
    });

    this.socket.on('connect', () => {
      log('Socket', 'Connected to relay');
      this.emit('connected');

      // Re-join channel on reconnect
      if (this.channelId) {
        this.joinChannel(this.channelId).then(() => {
          this.emit('reconnected');
        });
      }
    });

    this.socket.on('disconnect', (reason) => {
      log('Socket', `Disconnected: ${reason}`);
      this.emit('disconnected', reason);
    });

    this.socket.on('message', (data: RelayMessage) => {
      log('Socket', `Message received in channel ${data.id}`);
      this.emit('message', data);
    });

    this.socket.on('participants_changed', (data) => {
      log('Socket', `Participants changed: ${data.event}`);
      this.emit('participants_changed', data);
    });

    this.socket.on('connect_error', (err) => {
      warn('Socket', `Connection error: ${err.message}`);
      this.emit('error', err);
    });
  }

  /**
   * Join a relay channel.
   */
  async joinChannel(channelId: string): Promise<{ bufferedMessages: unknown[] }> {
    return new Promise((resolve, reject) => {
      if (!this.socket?.connected) {
        // Store channelId so we join on connect
        this.channelId = channelId;
        resolve({ bufferedMessages: [] });
        return;
      }

      this.channelId = channelId;

      this.socket.emit(
        'join_channel',
        { channelId, clientType: this.clientType },
        (response: { success: boolean; error?: string; bufferedMessages?: unknown[] }) => {
          if (response.success) {
            log('Socket', `Joined channel ${channelId}`);
            resolve({ bufferedMessages: response.bufferedMessages || [] });
          } else {
            logError('Socket', `Failed to join channel: ${response.error}`);
            reject(new Error(response.error || 'Failed to join channel'));
          }
        }
      );
    });
  }

  /**
   * Send a message through the relay.
   */
  sendMessage(data: RelayMessage): Promise<{ success: boolean; buffered: boolean }> {
    return new Promise((resolve, reject) => {
      if (!this.socket?.connected) {
        reject(new Error('Socket not connected'));
        return;
      }

      this.socket.emit('message', data, (response: { success: boolean; buffered: boolean; error?: string }) => {
        if (response?.success) {
          resolve({ success: true, buffered: response.buffered });
        } else {
          reject(new Error(response?.error || 'Failed to send message'));
        }
      });
    });
  }

  /**
   * Leave the current channel.
   */
  leaveChannel(): void {
    if (this.socket?.connected && this.channelId) {
      this.socket.emit('leave_channel', { channelId: this.channelId });
    }
    this.channelId = null;
  }

  /**
   * Disconnect from the relay.
   */
  disconnect(): void {
    this.channelId = null;
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
  }

  isConnected(): boolean {
    return this.socket?.connected ?? false;
  }

  getChannelId(): string | null {
    return this.channelId;
  }
}
