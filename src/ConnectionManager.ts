/**
 * Connection Manager - orchestrates socket lifecycle, the post-quantum
 * handshake, encrypted message routing, and session persistence for the
 * dApp side of QRL Connect v2.
 */

import EventEmitter from 'eventemitter3';
import {
  KeyExchange,
  type AckMessage,
  type PersistedSession,
  type SynAckMessage,
} from './KeyExchange.js';
import { SocketClient } from './SocketClient.js';
import {
  DEFAULT_RELAY_URL,
  STORAGE_KEY_PREFIX,
  SESSION_TTL_MS,
  WALLET_UNRESPONSIVE_MS,
  RECONNECT_WALLET_PROBE_MS,
  isCurrentQrlAddress,
} from './config.js';
import { cidFromString, generateConnectionURI } from './utils/qrUri.js';
import { toBase64 } from './PQCrypto.js';
import { randomUuid } from './crypto/primitives.js';
import { getBrowserLockManager, getBrowserStorage, SessionOwnership } from './SessionOwnership.js';
import { log, warn, error as logError } from './utils/logger.js';
import {
  type DAppMetadata,
  type DAppSession,
  type RelayMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
  ConnectionStatus,
  KeyExchangeMessageType,
  MessageType,
} from './types.js';

const DAPP_PARTICIPANT_CONFLICT_ERROR_MSG = 'dapp participant is already connected';

// ── Wire-input validation ─────────────────────────────────────
// Everything that arrives from the relay (or from localStorage) is untrusted
// until proven shaped. No type assertions on wire input: narrow with runtime
// guards and drop anything malformed.

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isCurrentQrlAddressArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isCurrentQrlAddress);
}

function isRelayMessage(v: unknown): v is RelayMessage {
  return (
    isRecord(v) &&
    typeof v.id === 'string' &&
    (v.clientType === 'dapp' || v.clientType === 'wallet') &&
    'message' in v &&
    (typeof v.message === 'string' || (typeof v.message === 'object' && v.message !== null))
  );
}

/** Wire `type` strings mapped back to the MessageType enum, no assertions. */
const MESSAGE_TYPE_BY_VALUE: Record<string, MessageType | undefined> = Object.fromEntries(
  Object.values(MessageType).map((m) => [m, m])
);

/** Validate a decrypted wire object into a JsonRpcResponse, or null if malformed. */
function parseJsonRpcResponse(msg: Record<string, unknown>): JsonRpcResponse | null {
  if (typeof msg.id !== 'string' && typeof msg.id !== 'number') return null;
  const out: JsonRpcResponse = {
    jsonrpc: typeof msg.jsonrpc === 'string' ? msg.jsonrpc : '2.0',
    id: msg.id,
  };
  if ('result' in msg) out.result = msg.result;
  if (msg.error !== undefined) {
    if (!isRecord(msg.error) || typeof msg.error.message !== 'string') return null;
    out.error = {
      code: typeof msg.error.code === 'number' ? msg.error.code : -32000,
      message: msg.error.message,
      data: msg.error.data,
    };
  }
  return out;
}

function parsePersistedKex(v: unknown): PersistedSession | null {
  if (!isRecord(v)) return null;
  const { cid, kAeadRaw, htx, sendDir, recvDir, sendSeq, recvSeq } = v;
  if (
    typeof cid !== 'string' ||
    typeof kAeadRaw !== 'string' ||
    typeof htx !== 'string' ||
    typeof sendDir !== 'string' ||
    typeof recvDir !== 'string' ||
    typeof sendSeq !== 'number' ||
    !Number.isSafeInteger(sendSeq) ||
    sendSeq >= Number.MAX_SAFE_INTEGER ||
    sendSeq < 0 ||
    typeof recvSeq !== 'number' ||
    !Number.isSafeInteger(recvSeq) ||
    recvSeq >= Number.MAX_SAFE_INTEGER ||
    recvSeq < 0
  ) {
    return null;
  }
  return { cid, kAeadRaw, htx, sendDir, recvDir, sendSeq, recvSeq };
}

function parseDAppMetadata(v: unknown): DAppMetadata | null {
  if (!isRecord(v) || typeof v.name !== 'string' || typeof v.url !== 'string') return null;
  const meta: DAppMetadata = { name: v.name, url: v.url };
  if (typeof v.icon === 'string') meta.icon = v.icon;
  if (typeof v.redirectUrl === 'string') meta.redirectUrl = v.redirectUrl;
  return meta;
}

/**
 * Validate raw localStorage JSON into a DAppSession, or null if malformed.
 *
 * Only version 4 is accepted. v2 sessions used sparse counter checkpoints.
 * v3 checkpointed every seal/open but had no cross-tab ownership and ignored
 * storage write failures. Neither older format can prove that its counters
 * are safe to resume, so both fail closed into a fresh pairing.
 */
function parseStoredSession(raw: string): DAppSession | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(v) || v.version !== 4) return null;
  if (typeof v.channelId !== 'string' || typeof v.chainId !== 'string') return null;
  if (typeof v.createdAt !== 'number' || typeof v.lastActivity !== 'number') return null;
  const keyExchange = parsePersistedKex(v.keyExchange);
  const dappMetadata = parseDAppMetadata(v.dappMetadata);
  if (!keyExchange || !dappMetadata || !isCurrentQrlAddressArray(v.connectedAccounts)) return null;
  return {
    version: 4,
    channelId: v.channelId,
    keyExchange,
    dappMetadata,
    connectedAccounts: v.connectedAccounts,
    chainId: v.chainId,
    createdAt: v.createdAt,
    lastActivity: v.lastActivity,
  };
}
// Best-effort cap: give the outbound TERMINATE up to this long to land on
// the relay before we tear the socket down. Matches the wallet side.
const TERMINATE_SEND_TIMEOUT_MS = 800;

interface ConnectionManagerEvents {
  status_changed: (status: ConnectionStatus) => void;
  accounts_changed: (accounts: string[]) => void;
  chain_changed: (chainId: string) => void;
  jsonrpc_response: (response: JsonRpcResponse) => void;
  wallet_info: (info: { accounts: string[]; chainId: string }) => void;
  connection_lost: () => void;
  /**
   * The session is dead for good (wallet TERMINATE, relay 'close', or a
   * tombstone observed on join). Distinct from a transient DISCONNECTED:
   * in-flight requests can never be answered and must be failed promptly
   * instead of running out the full request timeout.
   */
  session_terminated: () => void;
  error: (error: Error) => void;
}

/** Immutable identity for work that belongs to one channel/key/socket tuple. */
interface SessionWorkContext {
  generation: number;
  channelId: string;
  keyExchange: KeyExchange;
  socketClient: SocketClient;
}

export class ConnectionManager extends EventEmitter<ConnectionManagerEvents> {
  private socketClient: SocketClient;
  private keyExchange: KeyExchange | null = null;
  private status: ConnectionStatus = ConnectionStatus.DISCONNECTED;
  private channelId: string;
  private dappMetadata: DAppMetadata;
  private chainId: string;
  private relayUrl: string;
  private connectedAccounts: string[] = [];
  private storageKey: string;
  private unresponsiveTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectProbeTimer: ReturnType<typeof setTimeout> | null = null;
  private restoreInFlight: Promise<boolean> | null = null;
  private failedReconnects = 0;
  private walletPresent = false;
  private pendingRestore: DAppSession | null = null;
  private messageQueue: Promise<void> = Promise.resolve();
  private outboundQueue: Promise<void> = Promise.resolve();
  private persistenceQueue: Promise<void> = Promise.resolve();
  private readonly storage: Storage | null;
  private readonly persistenceEnabled: boolean;
  private readonly sessionOwnership: SessionOwnership | null;
  private persistenceBroken = false;
  private sessionCreatedAt = Date.now();
  private sessionGeneration = 0;
  private consecutiveDecryptFailures = 0;
  private static MAX_RECONNECT_FAILURES = 5;
  // Nonces derive from the recv counter and there is no gap tolerance, so a
  // genuinely desynced stream (peer advanced past us, e.g. the relay's
  // buffer TTL dropped a ciphertext) fails EVERY subsequent open. Two in a
  // row cannot happen on a healthy stream; requiring the second guards
  // against a one-off injected junk ciphertext killing a live session.
  private static MAX_DECRYPT_FAILURES = 2;

  constructor(options: {
    dappMetadata: DAppMetadata;
    relayUrl?: string | undefined;
    chainId?: string | undefined;
    storageKey?: string | undefined;
  }) {
    super();
    this.dappMetadata = options.dappMetadata;
    this.relayUrl = options.relayUrl ?? DEFAULT_RELAY_URL;
    this.chainId = options.chainId ?? '0x0';
    this.storageKey = options.storageKey ?? `${STORAGE_KEY_PREFIX}:session`;

    this.storage = getBrowserStorage();
    const lockManager = getBrowserLockManager();
    this.persistenceEnabled = this.storage !== null && lockManager !== null;
    this.sessionOwnership =
      this.persistenceEnabled && lockManager
        ? new SessionOwnership(this.storageKey, lockManager)
        : null;

    // Restoring a shared key without an atomic cross-tab lock can reuse an
    // AEAD nonce. On browsers without Web Locks, keep the session in memory
    // for this page only and drop any older persistent record.
    if (this.storage && !this.persistenceEnabled) {
      warn(
        'ConnectionManager',
        'Web Locks unavailable; disabling persisted sessions for AEAD safety'
      );
      this.removeStoredSession();
    }

    const stored = this.readStoredSession();
    if (stored) {
      this.channelId = stored.channelId;
      this.connectedAccounts = stored.connectedAccounts;
      this.chainId = stored.chainId;
      this.dappMetadata = stored.dappMetadata;
      this.pendingRestore = stored;
      this.sessionCreatedAt = stored.createdAt;
      log('ConnectionManager', `Found persisted session for channel ${this.channelId}`);
    } else {
      this.channelId = randomUuid();
    }

    this.socketClient = new SocketClient(this.relayUrl, 'dapp');
    this.setupSocketListeners();
  }

  // ── Setup ──────────────────────────────────────────────────

  private setupSocketListeners(): void {
    const socketClient = this.socketClient;
    const isCurrentSocket = (): boolean => this.socketClient === socketClient;

    socketClient.on('reconnected', (result) => {
      if (!isCurrentSocket()) return;
      // The re-join ack tells us, fresh, whether the channel was explicitly
      // terminated and whether the wallet is still present. The preceding
      // 'disconnected' cleared walletPresent, so without re-deriving it here
      // an idle-but-present wallet looks absent and the probe would tear down
      // a healthy session (and a tombstone would be ignored on auto-reconnect).
      if (result?.terminated) {
        log('ConnectionManager', 'Channel terminated, observed on auto-reconnect');
        this.handleSessionTerminated(true);
        return;
      }
      if (result) {
        this.walletPresent = result.participants.includes('wallet');
      }
      if (this.keyExchange?.areKeysExchanged()) {
        if (this.walletPresent) {
          this.clearReconnectProbe();
          this.setStatus(ConnectionStatus.CONNECTED);
          this.failedReconnects = 0;
        } else {
          // We have a live session but the wallet is not in the channel.
          // Don't sit in WAITING forever: give it a bounded window to
          // (re)appear, then surface DISCONNECTED so the dApp can fall back
          // to a fresh QR.
          this.setStatus(ConnectionStatus.WAITING);
          this.armReconnectProbe();
        }
      } else {
        // Handshake not yet complete; simply wait for wallet SYNACK.
        this.setStatus(ConnectionStatus.WAITING);
      }
    });

    socketClient.on('disconnected', () => {
      if (!isCurrentSocket()) return;
      this.walletPresent = false;
      if (
        this.keyExchange?.areKeysExchanged() &&
        (this.status === ConnectionStatus.CONNECTED ||
          this.status === ConnectionStatus.RECONNECTING ||
          this.status === ConnectionStatus.WAITING)
      ) {
        this.setStatus(ConnectionStatus.RECONNECTING);
        this.failedReconnects++;
        if (this.failedReconnects === ConnectionManager.MAX_RECONNECT_FAILURES) {
          this.emit('connection_lost');
        }
      }
    });

    socketClient.on('message', (data: RelayMessage) => {
      if (!isCurrentSocket()) return;
      const context = this.captureSessionWorkContext();
      if (context?.socketClient !== socketClient) return;
      this.enqueueRelayMessage(data, context);
    });

    socketClient.on('error', (err) => {
      if (!isCurrentSocket()) return;
      this.emit('error', err);
    });

    socketClient.on('participants_changed', (data) => {
      if (!isCurrentSocket()) return;
      if (data.event === 'join' && data.clientType === 'wallet') {
        this.walletPresent = true;
        log('ConnectionManager', 'Wallet joined channel');
        this.clearUnresponsiveTimer();
        this.clearReconnectProbe();
        if (this.keyExchange?.areKeysExchanged()) {
          this.failedReconnects = 0;
          this.setStatus(ConnectionStatus.CONNECTED);
        }
      }
      // 'close' is an explicit wallet/app-side termination (relay tombstone),
      // not a transient drop. Treat it as definitive: drop the session.
      if (data.event === 'close') {
        log('ConnectionManager', 'Wallet closed the channel (explicit terminate)');
        this.handleSessionTerminated(true);
        return;
      }
      if (data.event === 'disconnect' || data.event === 'leave') {
        if (data.clientType === 'wallet' || !data.clientType) {
          this.walletPresent = false;
          if (
            this.keyExchange?.areKeysExchanged() &&
            (this.status === ConnectionStatus.CONNECTED ||
              this.status === ConnectionStatus.RECONNECTING)
          ) {
            this.setStatus(ConnectionStatus.WAITING);
          }
          log('ConnectionManager', 'Wallet left channel');
        }
      }
    });
  }

  private setupKeyExchangeListeners(): void {
    const keyExchange = this.keyExchange;
    const generation = this.sessionGeneration;
    if (!keyExchange) return;
    keyExchange.on('keys_exchanged', () => {
      if (this.keyExchange !== keyExchange || this.sessionGeneration !== generation) return;
      log('ConnectionManager', 'Key exchange complete');
      this.clearReconnectProbe();
      this.setStatus(ConnectionStatus.CONNECTED);
      this.walletPresent = true;
      this.failedReconnects = 0;
      void this.sendEncrypted({
        type: MessageType.ORIGINATOR_INFO,
        originatorInfo: {
          ...this.dappMetadata,
          chainId: this.chainId,
        },
      }).catch((err: unknown) => {
        logError('ConnectionManager', 'Failed to send originator info:', err);
      });
    });
  }

  // ── Public API ─────────────────────────────────────────────

  /**
   * Generate a new v2 connection URI. Rotates channel id and keypair.
   * Returns a `qrlconnect://?q=…` URI safe for QR-rendering or deep-link.
   */
  async getConnectionURI(retryOnConflict = true): Promise<string> {
    const acquisitionGeneration = this.sessionGeneration;
    if (!(await this.acquireSessionOwnership())) {
      throw new Error('This QRL Connect session is active in another browser tab');
    }
    if (this.sessionGeneration !== acquisitionGeneration) {
      throw new Error('QRL Connect session changed while browser-tab ownership was pending');
    }

    // A fresh QR is a new cryptographic generation. Retire the prior transport
    // and queues first so delayed acknowledgements or queued plaintext cannot
    // cross into the replacement channel.
    this.invalidateSessionWork();
    this.socketClient.leaveChannel();
    this.socketClient.disconnect();
    this.socketClient = new SocketClient(this.relayUrl, 'dapp');
    this.setupSocketListeners();

    this.setStatus(ConnectionStatus.CONNECTING);
    this.clearReconnectProbe();
    this.pendingRestore = null;
    this.walletPresent = false;
    this.consecutiveDecryptFailures = 0;
    try {
      this.removeStoredSessionOrThrow();
    } catch (err) {
      this.setStatus(ConnectionStatus.DISCONNECTED);
      // A stale v4 record may still be present and this path has not created a
      // relay tombstone. Retain ownership so no second tab can restore that
      // counter stream while this page remains alive.
      throw err;
    }
    this.persistenceBroken = false;
    this.sessionCreatedAt = Date.now();

    this.keyExchange = new KeyExchange(true);
    this.setupKeyExchangeListeners();
    const pk = this.keyExchange.initiate();

    // Always rotate the channel id on fresh QR generation so that relay
    // buffers and participant lists from a prior pairing cannot leak in.
    this.channelId = randomUuid();
    const context = this.captureSessionWorkContext();
    if (!context) throw new Error('Failed to initialize QRL Connect session');

    // v2 protocol: upload the KEM public key to the relay before joining
    // so the relay can bind it to the channel and serve it back to the
    // wallet on its join_channel ack. The wallet verifies it against the
    // fingerprint carried in the QR - the PK itself is no longer in the QR.
    context.socketClient.setPublicKey(toBase64(pk));

    context.socketClient.connect();
    try {
      await context.socketClient.joinChannel(context.channelId);
      this.assertSessionWorkCurrent(context);
    } catch (err) {
      if (!this.isSessionWorkCurrent(context)) throw err;
      if (retryOnConflict && this.isDappParticipantConflictError(err)) {
        warn(
          'ConnectionManager',
          'Channel already has an active dApp participant. Rotating to a fresh channel.'
        );
        this.channelId = randomUuid();
        return this.getConnectionURI(false);
      }
      // A failed initial join is terminal for this pairing attempt. Stop the
      // Socket.IO retry loop and clear its channel so it cannot auto-rejoin as
      // a ghost participant after the caller has already received an error.
      this.invalidateSessionWork();
      this.keyExchange = null;
      context.socketClient.leaveChannel();
      context.socketClient.disconnect();
      this.setStatus(ConnectionStatus.DISCONNECTED);
      await this.releaseSessionOwnership();
      throw err;
    }

    this.setStatus(ConnectionStatus.WAITING);

    const uri = await generateConnectionURI(
      cidFromString(context.channelId),
      pk,
      this.relayUrl === DEFAULT_RELAY_URL ? undefined : this.relayUrl
    );
    this.assertSessionWorkCurrent(context);
    log('ConnectionManager', `Generated v2 connection URI for channel ${context.channelId}`);
    return uri;
  }

  /**
   * Reconnect to an existing session.
   * Returns false if there is nothing to restore.
   */
  async reconnect(): Promise<boolean> {
    // Single-flight: the constructor's auto-reconnect and an early request()
    // revival (ensureChannelJoined) can overlap. Hydrating KeyExchange twice
    // from the same pendingRestore snapshot would resurrect the counters the
    // first hydration has since advanced past.
    if (this.restoreInFlight) return this.restoreInFlight;
    const task = this.reconnectNow().finally(() => {
      this.restoreInFlight = null;
    });
    this.restoreInFlight = task;
    return task;
  }

  private async reconnectNow(): Promise<boolean> {
    // A successfully hydrated session already owns its key/counter stream.
    // Redundant reconnect calls must not re-read storage or release ownership
    // if that read fails transiently.
    if (this.keyExchange?.areKeysExchanged()) return true;
    if (!this.pendingRestore) return false;

    const acquisitionGeneration = this.sessionGeneration;
    if (!(await this.acquireSessionOwnership())) {
      this.setStatus(ConnectionStatus.DISCONNECTED);
      return false;
    }
    // resetForNewChannel(), getConnectionURI(), or disconnect() may have
    // retired this restore while Web Locks was deciding ownership. The newer
    // lifecycle owns the acquired lock, so the stale restore must return
    // without releasing it out from under that work.
    if (this.sessionGeneration !== acquisitionGeneration) return false;

    // The constructor may have read this record while another tab still held
    // the lock and advanced its counters. Refresh only after ownership is ours.
    const latest = this.readStoredSession();
    if (!latest) {
      this.pendingRestore = null;
      this.connectedAccounts = [];
      const storageInvalidated = this.clearSession();
      if (storageInvalidated) {
        await this.releaseSessionOwnership();
      } else {
        this.emit(
          'error',
          new Error('Unable to invalidate stored session; retaining browser-tab ownership')
        );
      }
      this.setStatus(ConnectionStatus.DISCONNECTED);
      return false;
    }
    this.pendingRestore = latest;
    this.channelId = latest.channelId;
    this.connectedAccounts = latest.connectedAccounts;
    this.chainId = latest.chainId;
    this.dappMetadata = latest.dappMetadata;
    this.sessionCreatedAt = latest.createdAt;

    this.invalidateSessionWork();
    const restoreGeneration = this.sessionGeneration;
    const restoreChannelId = this.channelId;
    const restoreSocketClient = this.socketClient;
    this.setStatus(ConnectionStatus.RECONNECTING);
    this.walletPresent = false;
    this.consecutiveDecryptFailures = 0;

    try {
      const session = await KeyExchange.sessionFromPersisted(this.pendingRestore.keyExchange);
      if (
        this.sessionGeneration !== restoreGeneration ||
        this.channelId !== restoreChannelId ||
        this.socketClient !== restoreSocketClient
      ) {
        return false;
      }
      this.keyExchange = new KeyExchange(true, session);
      this.pendingRestore = null;
      this.setupKeyExchangeListeners();
    } catch (err) {
      if (
        this.sessionGeneration !== restoreGeneration ||
        this.channelId !== restoreChannelId ||
        this.socketClient !== restoreSocketClient
      ) {
        return false;
      }
      logError('ConnectionManager', 'Failed to hydrate persisted session:', err);
      const storageInvalidated = this.clearSession();
      this.pendingRestore = null;
      this.connectedAccounts = [];
      this.keyExchange = null;
      if (storageInvalidated) {
        await this.releaseSessionOwnership();
      } else {
        this.emit(
          'error',
          new Error('Unable to invalidate stored session; retaining browser-tab ownership')
        );
      }
      this.setStatus(ConnectionStatus.DISCONNECTED);
      return false;
    }

    return this.joinAndSettle();
  }

  /**
   * (Re)open the socket, join the persisted channel, drain buffered relay
   * messages, and settle status. Shared by the cold-restore reconnect() and
   * the warm resume() path whose socket was torn down by the reconnect probe.
   * Assumes channelId and a hydrated keyExchange are already in place, and
   * that the caller has reset walletPresent + set RECONNECTING status.
   */
  private async joinAndSettle(): Promise<boolean> {
    const context = this.captureSessionWorkContext();
    if (!context) return false;
    context.socketClient.connect();
    try {
      const { bufferedMessages, participants, terminated } = await context.socketClient.joinChannel(
        context.channelId
      );
      if (!this.isSessionWorkCurrent(context)) return false;

      // The channel was explicitly closed (wallet/app forgot us). Drop the
      // stored session instead of waiting on a wallet that will never return.
      if (terminated) {
        log('ConnectionManager', 'Stored session was terminated by the wallet; dropping it');
        this.handleSessionTerminated(true);
        return false;
      }

      // Relay roster lets us know up front whether the wallet is present,
      // rather than relying on a future participants_changed event.
      if (participants.includes('wallet')) {
        this.walletPresent = true;
      }

      for (const msg of bufferedMessages) {
        this.enqueueRelayMessage(msg, context);
      }
      await this.messageQueue;
      if (!this.isSessionWorkCurrent(context)) return false;

      if (this.keyExchange?.areKeysExchanged() && this.walletPresent) {
        this.clearReconnectProbe();
        this.setStatus(ConnectionStatus.CONNECTED);
      } else {
        // Live channel but no wallet yet. Bound the wait so a gone wallet
        // doesn't strand the dApp in WAITING forever.
        this.setStatus(ConnectionStatus.WAITING);
        this.armReconnectProbe();
      }
      return true;
    } catch (err) {
      if (!this.isSessionWorkCurrent(context)) return false;
      logError('ConnectionManager', 'Reconnect failed:', err);
      this.setStatus(ConnectionStatus.DISCONNECTED);
      return false;
    }
  }

  /**
   * Nudge the connection back to life after the dApp tab / wallet app was
   * backgrounded. Idempotent and safe to call from visibilitychange / online
   * / pageshow handlers. If a restored session has not yet been hydrated,
   * runs the full reconnect(); otherwise just re-opens the socket, whose
   * own connect handler re-joins the channel and drains the relay buffer.
   */
  resume(): void {
    if (this.status === ConnectionStatus.CONNECTED) return;
    if (this.pendingRestore && !this.keyExchange?.areKeysExchanged()) {
      void this.reconnect();
      return;
    }
    if (this.channelId && this.keyExchange?.areKeysExchanged()) {
      // If the SocketClient still holds the channelId (a transient/background
      // socket drop), re-opening is enough: its connect handler re-joins the
      // channel and drains the buffer. But armReconnectProbe()'s timeout tears
      // the socket down AND nulls the SocketClient channelId, so there the
      // auto-rejoin can never fire - the socket would re-open but sit unjoined.
      // Detect that case and re-join explicitly.
      if (this.socketClient.getChannelId()) {
        this.socketClient.connect();
      } else {
        this.setStatus(ConnectionStatus.RECONNECTING);
        this.walletPresent = false;
        void this.joinAndSettle();
      }
    }
  }

  /**
   * Make sure the socket is open and joined to the paired session's channel
   * so an outbound request can be routed - or relay-buffered if the wallet is
   * currently absent (its socket dies within seconds of the app
   * backgrounding; the relay holds channel traffic for it). Revives the
   * socket after a probe-timeout teardown and hydrates a cold stored
   * session. Returns false when there is no session to revive (never paired,
   * explicit disconnect, or the channel was tombstoned).
   */
  async ensureChannelJoined(): Promise<boolean> {
    if (this.keyExchange?.areKeysExchanged()) {
      if (this.socketClient.isConnected() && this.socketClient.getChannelId()) {
        return true;
      }
      this.setStatus(ConnectionStatus.RECONNECTING);
      this.walletPresent = false;
      return this.joinAndSettle();
    }
    if (this.pendingRestore) {
      return this.reconnect();
    }
    return false;
  }

  /**
   * True while a pairing exists (handshake complete, session keys in
   * memory), even when the wallet's socket is momentarily out of the
   * channel. Survives the reconnect-probe teardown; false after an explicit
   * disconnect or a relay tombstone.
   */
  isPaired(): boolean {
    return this.keyExchange?.areKeysExchanged() ?? false;
  }

  /** True while the relay roster last showed the wallet in the channel. */
  isWalletPresent(): boolean {
    return this.walletPresent;
  }

  /**
   * A session was terminated for good (wallet sent a relay 'close', or the
   * join ack reported a tombstone). Clear local state and surface
   * DISCONNECTED so the consumer drops to a fresh-pairing UI.
   */
  private handleSessionTerminated(relayRetired: boolean): void {
    this.invalidateSessionWork();
    this.clearReconnectProbe();
    this.clearUnresponsiveTimer();
    this.walletPresent = false;
    this.consecutiveDecryptFailures = 0;
    this.pendingRestore = null;
    // Null the key exchange too. Otherwise channelId + areKeysExchanged() stay
    // truthy and a later resume() (tab foreground / online) would try to
    // re-join the now-dead channel. disconnect() clears it for the same reason.
    this.keyExchange = null;
    // Leave + drop the socket so we don't sit joined to a dead channel; the
    // probe-timeout teardown path does the same. Routing is refused on a
    // terminated channel, but a lingering joined socket is a needless resource.
    this.socketClient.leaveChannel();
    this.socketClient.disconnect();
    const storageInvalidated = this.clearSession();
    if (storageInvalidated) {
      void this.releaseSessionOwnership();
    } else {
      // Relay tombstones are bounded, in-memory liveness aids. They cannot
      // substitute for invalidating the durable browser record. Keep the Web
      // Lock for this page lifetime rather than expose stale counters to a tab.
      this.emit(
        'error',
        new Error('Unable to invalidate stored session; retaining browser-tab ownership')
      );
    }
    if (!relayRetired) warn('ConnectionManager', 'Relay channel termination was not confirmed');
    // Fail in-flight requests before the status flip so consumers observing
    // 'disconnect' never see them still pending. Internal teardown happens
    // first so a listener cannot revive state that this method then clears.
    this.emit('session_terminated');
    this.setStatus(ConnectionStatus.DISCONNECTED);
  }

  private armReconnectProbe(): void {
    this.clearReconnectProbe();
    this.reconnectProbeTimer = setTimeout(() => {
      this.reconnectProbeTimer = null;
      if (this.walletPresent) return;
      warn(
        'ConnectionManager',
        `No wallet rejoined within ${RECONNECT_WALLET_PROBE_MS}ms; treating reconnect as dead`
      );
      // Leave the channel and drop the socket so that if the wallet rejoins
      // later, participants_changed cannot flip the dApp back to CONNECTED and
      // emit phantom events after it already handled the disconnect. The
      // stored session is kept (the consumer offers a fresh QR; an explicit
      // terminate is what clears it).
      this.socketClient.leaveChannel();
      this.socketClient.disconnect();
      this.setStatus(ConnectionStatus.DISCONNECTED);
    }, RECONNECT_WALLET_PROBE_MS);
  }

  private clearReconnectProbe(): void {
    if (this.reconnectProbeTimer) {
      clearTimeout(this.reconnectProbeTimer);
      this.reconnectProbeTimer = null;
    }
  }

  /**
   * Send a JSON-RPC request to the wallet. Returns the outbound send promise
   * (settled on the relay's ack) so callers that must sequence on delivery -
   * e.g. the provider's wallet-wake redirect, which cannot navigate away
   * before the ciphertext reaches the relay - can await it. Callers may also
   * ignore it: failures are logged here either way.
   */
  sendJsonRpc(request: JsonRpcRequest): Promise<void> {
    if (!this.keyExchange?.areKeysExchanged()) {
      throw new Error('Not connected: key exchange not complete');
    }
    const sent = this.sendEncrypted({
      type: MessageType.JSONRPC,
      jsonrpc: '2.0',
      id: request.id,
      method: request.method,
      params: request.params,
    });
    sent.catch((err: unknown) => {
      logError('ConnectionManager', 'Failed to send JSON-RPC:', err);
    });
    this.startUnresponsiveTimer();
    return sent;
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }
  getAccounts(): string[] {
    return [...this.connectedAccounts];
  }
  getChainId(): string {
    return this.chainId;
  }
  getChannelId(): string {
    return this.channelId;
  }

  /** Check (sync) if a persisted session exists and has not expired. */
  hasStoredSession(): boolean {
    if (!this.persistenceEnabled || !this.storage) return false;
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (!raw) return false;
      const session = parseStoredSession(raw);
      if (!session) return false;
      return Date.now() - session.createdAt <= SESSION_TTL_MS;
    } catch {
      return false;
    }
  }

  /**
   * Best-effort TERMINATE delivery before we tear the socket down. Without
   * awaiting, the socket.disconnect() below would win the race against the
   * outbound emit, the wallet would only see `participants_changed:
   * disconnect` and enter its stale-session grace period instead of an
   * instant disconnect. Mirrors the wallet side's pattern.
   */
  private async flushTerminate(): Promise<void> {
    if (!this.keyExchange?.areKeysExchanged()) return;
    const send = this.sendEncrypted({ type: MessageType.TERMINATE }).catch(() => undefined);
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, TERMINATE_SEND_TIMEOUT_MS));
    await Promise.race([send, timeout]);
  }

  /**
   * Reset to a fresh channel + keypair. Sends TERMINATE to any live peer,
   * drops the persisted session, and prepares a clean state for
   * getConnectionURI() to be called again.
   */
  async resetForNewChannel(): Promise<void> {
    this.clearUnresponsiveTimer();
    this.clearReconnectProbe();
    this.walletPresent = false;

    await this.flushTerminate();

    const hadRelayChannel = this.socketClient.getChannelId() !== null;
    let relayRetired = false;
    try {
      relayRetired = await this.socketClient.closeChannel();
    } catch (err) {
      logError('ConnectionManager', 'Failed to tombstone reset channel:', err);
    }

    this.invalidateSessionWork();
    this.socketClient.leaveChannel();
    this.socketClient.disconnect();
    const storageInvalidated = this.clearSession();
    this.connectedAccounts = [];
    this.pendingRestore = null;
    this.channelId = randomUuid();
    this.keyExchange = null;
    this.persistenceBroken = false;
    this.sessionCreatedAt = Date.now();

    this.socketClient = new SocketClient(this.relayUrl, 'dapp');
    this.setupSocketListeners();

    this.setStatus(ConnectionStatus.DISCONNECTED);
    if (hadRelayChannel && !relayRetired) {
      warn('ConnectionManager', 'Reset channel termination was not confirmed');
    }
    if (!storageInvalidated) {
      const error = new Error(
        'Unable to invalidate stored session; retaining browser-tab ownership'
      );
      this.emit('error', error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.clearUnresponsiveTimer();
    this.clearReconnectProbe();
    this.walletPresent = false;

    await this.flushTerminate();

    const hadRelayChannel = this.socketClient.getChannelId() !== null;
    let relayRetired = false;
    try {
      relayRetired = await this.socketClient.closeChannel();
    } catch (err) {
      logError('ConnectionManager', 'Failed to tombstone disconnected channel:', err);
    }

    this.invalidateSessionWork();
    this.socketClient.leaveChannel();
    this.socketClient.disconnect();
    const storageInvalidated = this.clearSession();
    this.connectedAccounts = [];
    // Fully terminate the session: without clearing these, a later
    // visibilitychange/online resume() would re-open the socket and re-join
    // the channel after an explicit disconnect.
    this.pendingRestore = null;
    this.keyExchange = null;
    if (storageInvalidated) await this.releaseSessionOwnership();
    this.setStatus(ConnectionStatus.DISCONNECTED);
    if (hadRelayChannel && !relayRetired) {
      warn('ConnectionManager', 'Disconnected channel termination was not confirmed');
    }
    if (!storageInvalidated) {
      const error = new Error(
        'Unable to invalidate stored session; retaining browser-tab ownership'
      );
      this.emit('error', error);
      throw error;
    }
  }

  // ── Internals ──────────────────────────────────────────────

  private enqueueRelayMessage(data: unknown, context: SessionWorkContext): void {
    // Single validation funnel for both live socket messages and relay-buffered
    // backlog: nothing past this point handles an unshaped envelope.
    if (!isRelayMessage(data)) {
      warn('ConnectionManager', 'Dropping malformed relay envelope');
      return;
    }
    // Chain with .catch so that a single failing handler (tag-fail,
    // malformed JSON) does not leave the queue in a rejected state and
    // silently starve every subsequent message on the channel.
    this.messageQueue = this.messageQueue
      .then(() => this.handleRelayMessage(data, context))
      .catch((err: unknown) => {
        logError('ConnectionManager', 'messageQueue handler error:', err);
      });
  }

  private async handleRelayMessage(data: RelayMessage, context: SessionWorkContext): Promise<void> {
    if (!this.isSessionWorkCurrent(context)) return;
    if (data.clientType === 'wallet') {
      this.walletPresent = true;
      this.clearReconnectProbe();
      if (this.keyExchange?.areKeysExchanged() && this.status !== ConnectionStatus.CONNECTED) {
        this.failedReconnects = 0;
        this.setStatus(ConnectionStatus.CONNECTED);
      }
    }

    const message = data.message;

    if (isRecord(message)) {
      if (message.type === KeyExchangeMessageType.SYNACK) {
        if (typeof message.ct === 'string' && typeof message.c0 === 'string') {
          await this.handleSynAck(
            {
              type: KeyExchangeMessageType.SYNACK,
              ct: message.ct,
              c0: message.c0,
              v: typeof message.v === 'number' ? message.v : 0,
            },
            context
          );
        } else {
          warn('ConnectionManager', 'Dropping malformed SYNACK');
        }
        return;
      }
      if (
        message.type === KeyExchangeMessageType.SYN ||
        message.type === KeyExchangeMessageType.ACK
      ) {
        warn('ConnectionManager', `Unexpected ${message.type} on dApp side, ignoring`);
        return;
      }
    }

    if (typeof message === 'string' && context.keyExchange.areKeysExchanged()) {
      // The failure counter is scoped STRICTLY to the AEAD open. JSON.parse
      // errors or a throwing consumer listener reached via
      // handleDecryptedMessage happen after recvSeq advanced and say nothing
      // about stream health, so they must not count toward a teardown.
      let decrypted: string;
      try {
        decrypted = await context.keyExchange.decryptMessage(message);
      } catch (err) {
        if (!this.isSessionWorkCurrent(context)) return;
        logError('ConnectionManager', 'Failed to decrypt message:', err);
        this.consecutiveDecryptFailures++;
        if (this.consecutiveDecryptFailures >= ConnectionManager.MAX_DECRYPT_FAILURES) {
          await this.teardownDesyncedSession(context);
        }
        return;
      }
      if (!this.isSessionWorkCurrent(context)) return;
      this.consecutiveDecryptFailures = 0;
      try {
        // The AEAD counters advanced; checkpoint them before acting on the
        // plaintext so a reload cannot restore a stale recvSeq and reopen a
        // replay window for ciphertexts the relay has already delivered.
        await this.persistSession(context);
      } catch (err) {
        await this.teardownPersistenceFailedSession(err, context);
        return;
      }
      if (!this.isSessionWorkCurrent(context)) return;
      try {
        const parsed: unknown = JSON.parse(decrypted);
        if (isRecord(parsed)) {
          await this.handleDecryptedMessage(parsed, context);
        } else {
          warn('ConnectionManager', 'Dropping non-object decrypted payload');
        }
      } catch (err) {
        logError('ConnectionManager', 'Failed to handle decrypted message:', err);
      }
    }
  }

  /**
   * The receive stream is cryptographically unrecoverable: the peer's send
   * counter is ahead of our recv counter for good (relay buffer TTL/cap
   * dropped a ciphertext), so every future message would fail its tag.
   * An encrypted TERMINATE cannot communicate this (the desynced peer could
   * not open it either); tombstone the channel on the relay instead so the
   * wallet learns the pairing is dead even if it only re-joins later, then
   * clear local state and surface the standard terminated teardown.
   */
  private async teardownDesyncedSession(context: SessionWorkContext): Promise<void> {
    if (!this.isSessionWorkCurrent(context)) return;
    warn('ConnectionManager', 'AEAD stream desynced beyond recovery; terminating session');
    let relayRetired = false;
    try {
      relayRetired = await context.socketClient.closeChannel();
    } catch (err) {
      logError('ConnectionManager', 'Failed to tombstone desynced channel:', err);
    }
    if (!this.isSessionWorkCurrent(context)) return;
    this.handleSessionTerminated(relayRetired);
  }

  private async teardownPersistenceFailedSession(
    cause: unknown,
    context = this.captureSessionWorkContext(),
    reason = 'AEAD counter persistence failed; terminating session before further use'
  ): Promise<void> {
    if (!context || !this.isSessionWorkCurrent(context)) return;
    logError('ConnectionManager', `${reason}:`, cause);
    let relayRetired = false;
    try {
      relayRetired = await context.socketClient.closeChannel();
    } catch (err) {
      logError('ConnectionManager', 'Failed to tombstone unusable channel:', err);
    }
    if (!this.isSessionWorkCurrent(context)) return;
    this.handleSessionTerminated(relayRetired);
  }

  private async handleSynAck(msg: SynAckMessage, context: SessionWorkContext): Promise<void> {
    if (!this.isSessionWorkCurrent(context)) return;
    this.setStatus(ConnectionStatus.KEY_EXCHANGE);

    let response: AckMessage | null;
    try {
      response = await context.keyExchange.onSynAck(cidFromString(context.channelId), msg);
    } catch (err) {
      if (!this.isSessionWorkCurrent(context)) return;
      const e = err instanceof Error ? err : new Error(String(err));
      logError('ConnectionManager', 'SYNACK processing failed:', e);
      this.emit('error', e);
      let relayRetired = false;
      try {
        relayRetired = await context.socketClient.closeChannel();
      } catch (closeError) {
        logError('ConnectionManager', 'Failed to tombstone rejected handshake:', closeError);
      }
      if (this.isSessionWorkCurrent(context)) this.handleSessionTerminated(relayRetired);
      return;
    }
    if (!this.isSessionWorkCurrent(context)) return;
    if (response) {
      this.sendPlaintext(response, context);
      return;
    }
    // Duplicate SYNACK: the wallet re-sent it because it never saw our ACK
    // (its socket flapped right after SYNACK). Re-send the cached ACK so the
    // wallet can finalize; the bytes are deterministic and the wallet's
    // onAck is idempotent.
    const cachedAck = context.keyExchange.getLastAck();
    if (context.keyExchange.areKeysExchanged() && cachedAck) {
      log('ConnectionManager', 'Duplicate SYNACK after handshake; re-sending cached ACK');
      this.sendPlaintext(cachedAck, context);
    }
  }

  private async handleDecryptedMessage(
    msg: Record<string, unknown>,
    context: SessionWorkContext
  ): Promise<void> {
    if (!this.isSessionWorkCurrent(context)) return;
    this.clearUnresponsiveTimer();

    const type = typeof msg.type === 'string' ? msg.type : '';

    switch (MESSAGE_TYPE_BY_VALUE[type]) {
      case MessageType.WALLET_INFO: {
        if (!isCurrentQrlAddressArray(msg.accounts)) {
          warn('ConnectionManager', 'Dropping wallet info with malformed account addresses');
          break;
        }
        const nextAccounts = msg.accounts;
        const nextChainId =
          typeof msg.chainId === 'string' && msg.chainId ? msg.chainId : this.chainId;
        const accountsChanged = !this.areArraysEqual(this.connectedAccounts, nextAccounts);
        const chainChanged = this.chainId !== nextChainId;

        this.connectedAccounts = nextAccounts;
        this.chainId = nextChainId;
        void this.persistSession(context).catch((err: unknown) => {
          void this.teardownPersistenceFailedSession(err, context);
        });
        this.emit('wallet_info', {
          accounts: [...this.connectedAccounts],
          chainId: this.chainId,
        });
        if (accountsChanged) this.emit('accounts_changed', [...this.connectedAccounts]);
        if (chainChanged) this.emit('chain_changed', this.chainId);
        break;
      }

      case MessageType.JSONRPC: {
        const response = parseJsonRpcResponse(msg);
        if (!response) {
          warn('ConnectionManager', 'Dropping malformed JSON-RPC response');
          break;
        }
        this.emit('jsonrpc_response', response);
        break;
      }

      case MessageType.TERMINATE: {
        log('ConnectionManager', 'Received terminate from wallet');
        // Also create the durable relay tombstone. If localStorage cannot be
        // invalidated, a later reload is still unable to resume this channel.
        let relayRetired = false;
        try {
          relayRetired = await context.socketClient.closeChannel();
        } catch (err) {
          logError('ConnectionManager', 'Failed to tombstone terminated channel:', err);
        }
        if (this.isSessionWorkCurrent(context)) this.handleSessionTerminated(relayRetired);
        break;
      }

      default:
        log('ConnectionManager', `Unhandled message type: ${type}`);
    }
  }

  private sendPlaintext(message: object, context = this.captureSessionWorkContext()): void {
    if (!context || !this.isSessionWorkCurrent(context)) return;
    context.socketClient
      .sendMessage({
        id: context.channelId,
        clientType: 'dapp',
        message,
      })
      .catch((err: unknown) => {
        logError('ConnectionManager', 'Failed to send plaintext:', err);
      });
  }

  /**
   * Serialize every encrypt+persist+send on a single outbound queue.
   * Callers like sendJsonRpc() are fire-and-forget, so without the queue two
   * rapid provider.request() calls would interleave inside encryptMessage()
   * across its await and could complete out of order; the receiver's
   * contiguous-seq check would then drop the late one. (Nonce reuse itself is
   * already prevented by the synchronous seq reservation in KeyExchange.)
   */
  private sendEncrypted(message: object): Promise<void> {
    const context = this.captureSessionWorkContext();
    if (!context) return Promise.reject(new Error('sendEncrypted: not connected'));
    const task = this.outboundQueue.then(() => this.sendEncryptedNow(message, context));
    // Keep the chain alive after a failed send; the failure still propagates
    // to this task's caller.
    this.outboundQueue = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }

  private async sendEncryptedNow(message: object, context: SessionWorkContext): Promise<void> {
    if (!context.keyExchange.areKeysExchanged()) {
      throw new Error('sendEncrypted: not connected');
    }
    this.assertSessionWorkCurrent(context);
    const encrypted = await context.keyExchange.encryptMessage(JSON.stringify(message));
    this.assertSessionWorkCurrent(context);
    // Checkpoint the advanced sendSeq BEFORE the ciphertext can reach the
    // relay. If we crash in between, the stored counter is ahead (the wallet
    // drops the gap and the session dies cleanly); persisting after the send
    // could leave it behind, and a restored stale sendSeq would reuse an
    // AES-256-GCM nonce under the same key.
    try {
      await this.persistSession(context);
    } catch (err) {
      await this.teardownPersistenceFailedSession(err, context);
      throw err;
    }
    this.assertSessionWorkCurrent(context);
    try {
      await context.socketClient.sendMessage({
        id: context.channelId,
        clientType: 'dapp',
        message: encrypted,
      });
    } catch (err) {
      // The ciphertext may have reached the relay even when its acknowledgement
      // was lost. Its sequence number cannot be retried, and continuing would
      // create a permanent gap, so retire this generation immediately.
      await this.teardownPersistenceFailedSession(
        err,
        context,
        'Relay send outcome unknown; terminating session before further use'
      );
      throw err;
    }
  }

  private startUnresponsiveTimer(): void {
    this.clearUnresponsiveTimer();
    this.unresponsiveTimer = setTimeout(() => {
      warn('ConnectionManager', 'Wallet appears unresponsive');
    }, WALLET_UNRESPONSIVE_MS);
  }

  private clearUnresponsiveTimer(): void {
    if (this.unresponsiveTimer) {
      clearTimeout(this.unresponsiveTimer);
      this.unresponsiveTimer = null;
    }
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status !== status) {
      this.status = status;
      this.emit('status_changed', status);
    }
  }

  private isDappParticipantConflictError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return msg.toLowerCase().includes(DAPP_PARTICIPANT_CONFLICT_ERROR_MSG);
  }

  private areArraysEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // ── Persistence ────────────────────────────────────────────

  private invalidateSessionWork(): void {
    this.sessionGeneration++;
    // Advance the generation before wiping the retired handshake so stale
    // async continuations fail their context check. reset() zeroizes any
    // live ML-KEM secret-key buffer held by a pre-SYNACK KeyExchange.
    this.keyExchange?.reset();
    // New work must never queue behind a promise owned by the retired session.
    // Existing tasks retain their old generation and fail their context checks.
    this.messageQueue = Promise.resolve();
    this.outboundQueue = Promise.resolve();
    this.persistenceQueue = Promise.resolve();
  }

  private captureSessionWorkContext(): SessionWorkContext | null {
    if (!this.keyExchange) return null;
    return {
      generation: this.sessionGeneration,
      channelId: this.channelId,
      keyExchange: this.keyExchange,
      socketClient: this.socketClient,
    };
  }

  private isSessionWorkCurrent(context: SessionWorkContext): boolean {
    return (
      context.generation === this.sessionGeneration &&
      context.channelId === this.channelId &&
      context.keyExchange === this.keyExchange &&
      context.socketClient === this.socketClient
    );
  }

  private assertSessionWorkCurrent(context: SessionWorkContext): void {
    if (!this.isSessionWorkCurrent(context)) {
      throw new Error('QRL Connect session changed while encrypted work was pending');
    }
  }

  private async acquireSessionOwnership(): Promise<boolean> {
    if (!this.persistenceEnabled) return true;
    if (!this.sessionOwnership) return false;
    return this.sessionOwnership.acquire();
  }

  private async releaseSessionOwnership(): Promise<void> {
    await this.sessionOwnership?.release();
  }

  private persistSession(context: SessionWorkContext): Promise<void> {
    const task = this.persistenceQueue.then(() => this.persistSessionNow(context));
    this.persistenceQueue = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }

  private async persistSessionNow(context: SessionWorkContext): Promise<void> {
    this.assertSessionWorkCurrent(context);
    if (!this.persistenceEnabled || !this.storage) return;
    if (!this.sessionOwnership?.isOwned()) {
      throw new Error('Cannot persist AEAD counters without browser-tab ownership');
    }
    if (this.persistenceBroken) {
      throw new Error('AEAD counter persistence is unavailable');
    }
    const persistedKex = await context.keyExchange.exportPersisted();
    if (!persistedKex) throw new Error('Cannot export established AEAD session');
    // exportPersisted() crosses a WebCrypto await. A disconnect or fresh
    // pairing may have retired this generation and released its lock while the
    // export was in flight; never resurrect or overwrite state afterward.
    this.assertSessionWorkCurrent(context);
    if (!this.sessionOwnership?.isOwned()) {
      throw new Error('Browser-tab ownership changed while persisting AEAD counters');
    }

    const session: DAppSession = {
      version: 4,
      channelId: context.channelId,
      keyExchange: persistedKex,
      dappMetadata: this.dappMetadata,
      connectedAccounts: this.connectedAccounts,
      chainId: this.chainId,
      createdAt: this.sessionCreatedAt,
      lastActivity: Date.now(),
    };

    try {
      this.storage.setItem(this.storageKey, JSON.stringify(session));
    } catch (err) {
      this.persistenceBroken = true;
      this.removeStoredSession();
      logError('ConnectionManager', 'Failed to persist AEAD counters:', err);
      throw new Error('Failed to persist AEAD counters');
    }
  }

  private readStoredSession(): DAppSession | null {
    if (!this.persistenceEnabled || !this.storage) return null;
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (!raw) return null;
      const session = parseStoredSession(raw);
      if (!session) {
        // Legacy (pre-v4) or malformed record: clear to force a fresh pairing.
        log('ConnectionManager', 'Dropping legacy or malformed session from storage');
        this.removeStoredSession();
        return null;
      }
      if (Date.now() - session.createdAt > SESSION_TTL_MS) {
        this.removeStoredSession();
        return null;
      }
      return session;
    } catch {
      return null;
    }
  }

  private removeStoredSession(): boolean {
    if (!this.storage) return true;
    try {
      this.storage.removeItem(this.storageKey);
      return true;
    } catch (removeError) {
      // Some storage wrappers can reject deletion while still permitting an
      // overwrite. Replacing the record with an invalid version is equally
      // safe: the next constructor cannot hydrate the retired AEAD stream.
      try {
        this.storage.setItem(this.storageKey, '{"version":0}');
        warn('ConnectionManager', 'localStorage.removeItem failed; invalidated record instead');
        return true;
      } catch (overwriteError) {
        warn(
          'ConnectionManager',
          'Unable to invalidate persisted session:',
          removeError,
          overwriteError
        );
        return false;
      }
    }
  }

  private removeStoredSessionOrThrow(): void {
    if (!this.removeStoredSession()) {
      throw new Error('Unable to clear the previous persisted AEAD session');
    }
  }

  private clearSession(): boolean {
    return this.removeStoredSession();
  }
}
