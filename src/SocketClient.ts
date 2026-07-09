/**
 * Socket.IO client wrapper for relay communication.
 */

import { io, Socket } from 'socket.io-client';
import EventEmitter from 'eventemitter3';
import { RELAY_PATH } from './config.js';

// Cap how long a deferred joinChannel() will wait for the socket to come
// up before giving up. Without this the caller's await hangs forever if
// the relay is unreachable (socket.io retries internally, but our
// pendingJoin only resolves on `connect`).
const PENDING_JOIN_TIMEOUT_MS = 20000;
// Bounded window for awaiting a relay ack before the caller is allowed to
// tear the socket down. socket.io buffers emits and disconnect() drops
// anything unflushed, so a fire-and-forget close_channel would race the
// teardown and the tombstone could never land. Mirrors the wallet side.
const SEND_FLUSH_TIMEOUT_MS = 600;
import { log, warn, error as logError } from './utils/logger.js';
import type { RelayMessage } from './types.js';

interface SocketClientEvents {
  message: (data: RelayMessage) => void;
  connected: () => void;
  disconnected: (reason: string) => void;
  reconnected: (result: JoinResult) => void;
  participants_changed: (data: { event: string; clientType?: string }) => void;
  error: (err: Error) => void;
}

export interface JoinResult {
  bufferedMessages: unknown[];
  /**
   * Base64-encoded KEM public key the relay has bound to this channel.
   * Populated for wallet joins (v2 protocol). `null` if the dApp hasn't
   * registered a PK yet - wallet callers must treat this as a retry signal.
   */
  channelPublicKey: string | null;
  /**
   * Client types of the OTHER participants already in the channel at join
   * time (e.g. `['wallet']` or `[]`). Lets a (re)joining peer detect an
   * absent counterparty immediately instead of waiting on a future
   * participants_changed event. Empty array on older relays.
   */
  participants: string[];
  /**
   * True if the channel was explicitly closed (a terminated tombstone). The
   * peer should drop its stored session rather than wait or re-pair.
   */
  terminated: boolean;
}

export class SocketClient extends EventEmitter<SocketClientEvents> {
  private socket: Socket | null = null;
  private relayUrl: string;
  private channelId: string | null = null;
  private clientType: 'dapp' | 'wallet';
  // The dApp's own PK (base64) that must be uploaded with every join
  // attempt so the relay can bind it to the channel. Wallet-side leaves
  // this undefined.
  private publicKeyBase64: string | null = null;
  private seq = 0;
  private pendingJoin: {
    channelId: string;
    promise: Promise<JoinResult>;
    resolve: (result: JoinResult) => void;
    reject: (error: Error) => void;
    watchdog: ReturnType<typeof setTimeout>;
  } | null = null;

  constructor(relayUrl: string, clientType: 'dapp' | 'wallet') {
    super();
    this.relayUrl = relayUrl;
    this.clientType = clientType;
  }

  /**
   * dApp-only: stash the PK so it gets uploaded on every join_channel
   * attempt (including auto-rejoins after reconnect).
   */
  setPublicKey(publicKeyBase64: string): void {
    if (this.clientType !== 'dapp') {
      throw new Error('SocketClient.setPublicKey is only valid for dApp clients');
    }
    this.publicKeyBase64 = publicKeyBase64;
  }

  /**
   * Connect to the relay server.
   */
  connect(): void {
    if (this.socket) {
      // A socket already exists. It may be mid socket.io auto-reconnect
      // (non-null but disconnected). Constructing a second io() here would
      // orphan the first - it keeps retrying forever and double-joins the
      // channel. Reuse the existing socket; nudge it if it is currently down.
      if (!this.socket.connected) this.socket.connect();
      return;
    }

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
        const reconnectChannelId = this.channelId;
        this.joinChannelNow(reconnectChannelId)
          .then((result) => {
            this.settlePendingJoin(reconnectChannelId, { result });
            // Carry the re-join ack (roster + terminated) so ConnectionManager
            // can re-derive walletPresent instead of relying on the stale flag
            // cleared by the preceding 'disconnected'.
            this.emit('reconnected', result);
          })
          .catch((err: unknown) => {
            const reconnectErr = err instanceof Error ? err : new Error(String(err));
            this.settlePendingJoin(reconnectChannelId, { error: reconnectErr });
            logError('Socket', `Rejoin failed: ${reconnectErr.message}`);
            this.emit('error', reconnectErr);
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

    this.socket.on('participants_changed', (data: unknown) => {
      if (typeof data !== 'object' || data === null) return;
      const rec: Record<string, unknown> = { ...data };
      const event = typeof rec.event === 'string' ? rec.event : '';
      log('Socket', `Participants changed: ${event}`);
      this.emit('participants_changed', {
        event,
        ...(typeof rec.clientType === 'string' ? { clientType: rec.clientType } : {}),
      });
    });

    this.socket.on('connect_error', (err) => {
      warn('Socket', `Connection error: ${err.message}`);
      // If the caller's `joinChannel()` is waiting on this connection and
      // we've exhausted the underlying socket.io retry budget (rare - it
      // retries forever by default), the watchdog in `pendingJoin` will
      // reject. We don't reject here because socket.io will retry
      // automatically, but we do emit so subscribers can react.
      this.emit('error', err);
    });
  }

  /**
   * Resolve or reject the currently-pending `joinChannel` promise, if it
   * matches the given channelId. Clears the watchdog timer on settle so
   * it doesn't fire after the fact.
   */
  private settlePendingJoin(
    channelId: string,
    outcome: { result: JoinResult } | { error: Error }
  ): void {
    if (this.pendingJoin?.channelId !== channelId) return;
    clearTimeout(this.pendingJoin.watchdog);
    const pending = this.pendingJoin;
    this.pendingJoin = null;
    if ('result' in outcome) {
      pending.resolve(outcome.result);
    } else {
      pending.reject(outcome.error);
    }
  }

  /**
   * Join a relay channel. Resolves with any buffered messages plus the
   * dApp's public key bound to the channel (for wallet joins).
   */
  async joinChannel(channelId: string): Promise<JoinResult> {
    if (!this.socket) {
      throw new Error('Socket not initialized. Call connect() before joinChannel()');
    }

    this.channelId = channelId;

    // If already connected, join immediately.
    if (this.socket.connected) {
      return this.joinChannelNow(channelId);
    }

    // If waiting for connect, return a promise that resolves/rejects when the
    // connect handler executes the actual join_channel request.
    if (this.pendingJoin) {
      if (this.pendingJoin.channelId === channelId) {
        return this.pendingJoin.promise;
      }
      clearTimeout(this.pendingJoin.watchdog);
      this.pendingJoin.reject(new Error('Join request superseded by a newer channel'));
      this.pendingJoin = null;
    }

    let resolvePending!: (result: JoinResult) => void;
    let rejectPending!: (error: Error) => void;
    const promise = new Promise<JoinResult>((resolve, reject) => {
      resolvePending = resolve;
      rejectPending = reject;
    });

    // Watchdog so an unreachable relay doesn't hang the caller forever.
    // socket.io's own `reconnectionAttempts: Infinity` means no amount of
    // connect_error events will ever abort from its side.
    const watchdog = setTimeout(() => {
      this.settlePendingJoin(channelId, {
        error: new Error(`joinChannel timed out after ${PENDING_JOIN_TIMEOUT_MS}ms`),
      });
    }, PENDING_JOIN_TIMEOUT_MS);

    this.pendingJoin = {
      channelId,
      promise,
      resolve: resolvePending,
      reject: rejectPending,
      watchdog,
    };

    return promise;
  }

  private joinChannelNow(channelId: string): Promise<JoinResult> {
    return new Promise((resolve, reject) => {
      if (!this.socket?.connected) {
        reject(new Error('Socket not connected'));
        return;
      }

      const payload: {
        channelId: string;
        clientType: 'dapp' | 'wallet';
        publicKey?: string;
      } = { channelId, clientType: this.clientType };
      if (this.clientType === 'dapp' && this.publicKeyBase64) {
        payload.publicKey = this.publicKeyBase64;
      }

      this.socket.emit(
        'join_channel',
        payload,
        (response: {
          success: boolean;
          error?: string;
          bufferedMessages?: unknown[];
          channelPublicKey?: string | null;
          participants?: string[];
          terminated?: boolean;
        }) => {
          if (response.success) {
            log('Socket', `Joined channel ${channelId}`);
            resolve({
              bufferedMessages: response.bufferedMessages ?? [],
              channelPublicKey: response.channelPublicKey ?? null,
              participants: response.participants ?? [],
              terminated: response.terminated === true,
            });
          } else {
            logError('Socket', `Failed to join channel: ${response.error}`);
            reject(new Error(response.error ?? 'Failed to join channel'));
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

      const dataWithSeq = { ...data, seq: this.seq++ };
      this.socket.emit(
        'message',
        dataWithSeq,
        (response: { success: boolean; buffered: boolean; error?: string }) => {
          if (response?.success) {
            resolve({ success: true, buffered: response.buffered });
          } else {
            reject(new Error(response?.error ?? 'Failed to send message'));
          }
        }
      );
    });
  }

  /**
   * Emit an event and resolve once the relay acks it, or after a bounded
   * flush window. Lets a caller await transmission before tearing the
   * socket down.
   */
  private flushEmit(event: string, payload: object): Promise<void> {
    return new Promise((resolve) => {
      if (!this.socket?.connected) {
        resolve();
        return;
      }
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const timer = setTimeout(done, SEND_FLUSH_TIMEOUT_MS);
      this.socket.emit(event, payload, () => {
        clearTimeout(timer);
        done();
      });
    });
  }

  /**
   * Explicitly terminate the channel on the relay (durable tombstone), as
   * opposed to the transient leaveChannel(). Used when the session is dead
   * in a way an encrypted TERMINATE cannot communicate (AEAD desync: the
   * peer could not open it). Resolves once the close is flushed or the
   * bounded window elapses, so the caller can safely disconnect afterwards.
   */
  closeChannel(): Promise<void> {
    const channelId = this.channelId;
    this.channelId = null;
    if (this.pendingJoin) {
      clearTimeout(this.pendingJoin.watchdog);
      this.pendingJoin.reject(new Error('Channel closed before join completed'));
      this.pendingJoin = null;
    }
    if (!this.socket?.connected || !channelId) return Promise.resolve();
    return this.flushEmit('close_channel', { channelId });
  }

  /**
   * Leave the current channel.
   */
  leaveChannel(): void {
    if (this.pendingJoin) {
      clearTimeout(this.pendingJoin.watchdog);
      this.pendingJoin.reject(new Error('Channel left before join completed'));
      this.pendingJoin = null;
    }
    if (this.socket?.connected && this.channelId) {
      this.socket.emit('leave_channel', { channelId: this.channelId });
    }
    this.channelId = null;
  }

  /**
   * Disconnect from the relay.
   */
  disconnect(): void {
    if (this.pendingJoin) {
      clearTimeout(this.pendingJoin.watchdog);
      this.pendingJoin.reject(new Error('Socket disconnected before join completed'));
      this.pendingJoin = null;
    }
    this.channelId = null;
    this.seq = 0;
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
