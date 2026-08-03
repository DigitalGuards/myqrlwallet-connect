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
export const PENDING_JOIN_TIMEOUT_MS = 20_000;
// Bounded window for awaiting a relay ack before the caller is allowed to
// tear the socket down. socket.io buffers emits and disconnect() drops
// anything unflushed, so a fire-and-forget close_channel would race the
// teardown and the tombstone could never land. Mirrors the wallet side.
const SEND_FLUSH_TIMEOUT_MS = 600;
// A normal relay message has already consumed and checkpointed an AEAD
// sequence number by the time it reaches this layer. An acknowledgement that
// never arrives must therefore settle as an ambiguous failure instead of
// pinning ConnectionManager's outbound queue forever.
export const MESSAGE_ACK_TIMEOUT_MS = 15_000;
import { log, warn, error as logError } from './utils/logger.js';
import type { RelayMessage } from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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

interface PendingSend {
  timer: ReturnType<typeof setTimeout>;
  reject: (error: Error) => void;
}

interface PendingJoinAttempt {
  timer: ReturnType<typeof setTimeout>;
  reject: (error: Error) => void;
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
  private pendingSends = new Set<PendingSend>();
  private pendingJoinAttempts = new Set<PendingJoinAttempt>();

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
      this.rejectPendingJoinAttempts(
        new Error(`Socket disconnected before join acknowledgement: ${reason}`)
      );
      this.rejectPendingSends(
        new Error(`Socket disconnected before relay acknowledgement: ${reason}`)
      );
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
      if (this.channelId === channelId) {
        this.channelId = null;
        // This initial/deferred join has failed terminally. Stop socket.io's
        // infinite reconnect loop so it cannot leave an idle relay transport
        // behind after the caller has abandoned the pairing attempt.
        const socket = this.socket;
        if (socket) {
          socket.removeAllListeners();
          socket.disconnect();
          if (this.socket === socket) this.socket = null;
        }
      }
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
      const socket = this.socket;
      if (!socket?.connected) {
        reject(new Error('Socket not connected'));
        return;
      }

      let settled = false;
      const abandonJoin = (): void => {
        if (this.channelId !== channelId) return;
        // The join outcome is ambiguous when its acknowledgement is lost. The
        // leave is ordered after join_channel on this socket, so it retires a
        // late server-side join before future code can mistake channelId for a
        // confirmed membership.
        if (socket.connected) socket.emit('leave_channel', { channelId });
        this.channelId = null;
      };
      const finish = (outcome: { result: JoinResult } | { error: Error }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(pending.timer);
        this.pendingJoinAttempts.delete(pending);
        if ('result' in outcome) resolve(outcome.result);
        else reject(outcome.error);
      };
      const pending: PendingJoinAttempt = {
        timer: setTimeout(() => {
          abandonJoin();
          finish({
            error: new Error(
              `joinChannel acknowledgement timed out after ${PENDING_JOIN_TIMEOUT_MS}ms`
            ),
          });
        }, PENDING_JOIN_TIMEOUT_MS),
        reject: (error: Error) => {
          finish({ error });
        },
      };
      this.pendingJoinAttempts.add(pending);

      const payload: {
        channelId: string;
        clientType: 'dapp' | 'wallet';
        publicKey?: string;
      } = { channelId, clientType: this.clientType };
      if (this.clientType === 'dapp' && this.publicKeyBase64) {
        payload.publicKey = this.publicKeyBase64;
      }

      socket.emit('join_channel', payload, (response: unknown) => {
        if (!isRecord(response)) {
          abandonJoin();
          finish({ error: new Error('Relay returned a malformed join acknowledgement') });
          return;
        }
        if (response.success === true) {
          log('Socket', `Joined channel ${channelId}`);
          finish({
            result: {
              bufferedMessages: Array.isArray(response.bufferedMessages)
                ? response.bufferedMessages
                : [],
              channelPublicKey:
                typeof response.channelPublicKey === 'string' ? response.channelPublicKey : null,
              participants: Array.isArray(response.participants)
                ? response.participants.filter(
                    (participant): participant is string => typeof participant === 'string'
                  )
                : [],
              terminated: response.terminated === true,
            },
          });
        } else {
          const relayError =
            typeof response.error === 'string' ? response.error : 'Failed to join channel';
          logError('Socket', `Failed to join channel: ${relayError}`);
          abandonJoin();
          finish({ error: new Error(relayError) });
        }
      });
    });
  }

  private rejectPendingJoinAttempts(error: Error): void {
    for (const pending of [...this.pendingJoinAttempts]) pending.reject(error);
  }

  /**
   * Send a message through the relay.
   */
  sendMessage(data: RelayMessage): Promise<{ success: boolean; buffered: boolean }> {
    return new Promise((resolve, reject) => {
      const socket = this.socket;
      if (!socket?.connected) {
        reject(new Error('Socket not connected'));
        return;
      }

      const dataWithSeq = { ...data, seq: this.seq++ };
      let settled = false;
      const finish = (
        outcome: { result: { success: true; buffered: boolean } } | { error: Error }
      ): void => {
        if (settled) return;
        settled = true;
        clearTimeout(pending.timer);
        this.pendingSends.delete(pending);
        if ('result' in outcome) resolve(outcome.result);
        else reject(outcome.error);
      };
      const pending: PendingSend = {
        timer: setTimeout(() => {
          finish({
            error: new Error(
              `Relay message acknowledgement timed out after ${MESSAGE_ACK_TIMEOUT_MS}ms`
            ),
          });
        }, MESSAGE_ACK_TIMEOUT_MS),
        reject: (error: Error) => {
          finish({ error });
        },
      };
      this.pendingSends.add(pending);

      socket.emit(
        'message',
        dataWithSeq,
        (response: { success: boolean; buffered: boolean; error?: string }) => {
          if (response?.success) {
            finish({ result: { success: true, buffered: response.buffered } });
          } else {
            finish({ error: new Error(response?.error ?? 'Failed to send message') });
          }
        }
      );
    });
  }

  private rejectPendingSends(error: Error): void {
    for (const pending of [...this.pendingSends]) pending.reject(error);
  }

  /**
   * Emit an event and resolve once the relay acks it, or after a bounded
   * flush window. Lets a caller await transmission before tearing the
   * socket down.
   */
  private flushEmit(event: string, payload: object): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this.socket?.connected) {
        resolve(false);
        return;
      }
      let settled = false;
      const done = (confirmed: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(confirmed);
      };
      const timer = setTimeout(() => {
        done(false);
      }, SEND_FLUSH_TIMEOUT_MS);
      this.socket.emit(event, payload, (response: unknown) => {
        clearTimeout(timer);
        done(isRecord(response) && response.success === true && response.terminated === true);
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
  closeChannel(): Promise<boolean> {
    const channelId = this.channelId;
    this.channelId = null;
    if (this.pendingJoin) {
      clearTimeout(this.pendingJoin.watchdog);
      this.pendingJoin.reject(new Error('Channel closed before join completed'));
      this.pendingJoin = null;
    }
    this.rejectPendingJoinAttempts(new Error('Channel closed before join completed'));
    if (!this.socket?.connected || !channelId) return Promise.resolve(false);
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
    this.rejectPendingJoinAttempts(new Error('Channel left before join completed'));
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
    this.rejectPendingJoinAttempts(new Error('Socket disconnected before join completed'));
    this.channelId = null;
    this.seq = 0;
    this.rejectPendingSends(new Error('Socket disconnected before relay acknowledgement'));
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
