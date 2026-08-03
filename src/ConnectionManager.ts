/**
 * Connection Manager - orchestrates socket lifecycle, the post-quantum
 * handshake, encrypted message routing, and session persistence for the
 * dApp side of QRL Connect v3.
 */

import EventEmitter from 'eventemitter3';
import {
  KeyExchange,
  SYNACK_C0_LEN,
  type AckMessage,
  type PersistedSession,
  type SynAckMessage,
} from './KeyExchange.js';
import { SocketClient, type JoinResult } from './SocketClient.js';
import {
  DEFAULT_RELAY_URL,
  STORAGE_KEY_PREFIX,
  SESSION_TTL_MS,
  WALLET_UNRESPONSIVE_MS,
  RECONNECT_WALLET_PROBE_MS,
  PROTOCOL_VERSION,
  classifyRpcMethod,
  isCurrentQrlAddress,
  isExplicitLoopbackHostname,
  isValidJsonRpcId,
  isValidJsonRpcMethod,
  normalizeRelayUrl,
} from './config.js';
import { cidFromString, generateConnectionURI } from './utils/qrUri.js';
import {
  DIR_DAPP_TX,
  DIR_WALLET_TX,
  ML_KEM_768_CT_LEN,
  isCanonicalBase64OfLength,
  toBase64,
} from './PQCrypto.js';
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
const MAX_RELAY_CIPHERTEXT_CHARS = 256 * 1024;
const MAX_JSON_RPC_ERROR_MESSAGE_CHARS = 1024;
const MAX_DAPP_NAME_CHARS = 128;
const MAX_DAPP_URL_CHARS = 2048;
const MAX_DAPP_ICON_CHARS = 4096;
const MAX_CHAIN_ID_CHARS = 66;
const MAX_STORED_CLOCK_SKEW_MS = 5 * 60 * 1000;
const PERSISTED_CID_LEN = 16;
const PERSISTED_AEAD_KEY_LEN = 32;
const PERSISTED_HTX_LEN = 32;
const PERSISTED_DIRECTION_LEN = 4;
const MAX_CONNECTED_ACCOUNTS = 1;
const DAPP_TX_B64 = toBase64(DIR_DAPP_TX);
const WALLET_TX_B64 = toBase64(DIR_WALLET_TX);

// ── Wire-input validation ─────────────────────────────────────
// Everything that arrives from the relay (or from localStorage) is untrusted
// until proven shaped. No type assertions on wire input: narrow with runtime
// guards and drop anything malformed.

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Match the wallet's visual-spoofing rejection for authenticated dApp names. */
function hasUnsafeDAppNameCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x061c ||
      code === 0x180e ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x2028 && code <= 0x202e) ||
      code === 0x2060 ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0xfeff
    ) {
      return true;
    }
  }
  return false;
}

function canonicalChainId(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_CHAIN_ID_CHARS ||
    !/^0x[0-9a-fA-F]+$/.test(value)
  ) {
    return null;
  }
  try {
    return `0x${BigInt(value).toString(16)}`;
  } catch {
    return null;
  }
}

/** Canonicalize metadata navigation URLs at the dApp/wallet trust boundary. */
function canonicalDAppHttpUrl(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_DAPP_URL_CHARS ||
    value.trim() !== value
  ) {
    return null;
  }
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const isLoopback = isExplicitLoopbackHostname(hostname);
    if (
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) ||
      url.username !== '' ||
      url.password !== '' ||
      hostname === ''
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function isBoundedTimestamp(value: unknown, now: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= now + MAX_STORED_CLOCK_SKEW_MS
  );
}

function isCurrentQrlAddressArray(v: unknown): v is string[] {
  return (
    Array.isArray(v) &&
    v.length <= MAX_CONNECTED_ACCOUNTS &&
    v.every(isCurrentQrlAddress) &&
    new Set(v).size === v.length
  );
}

function isRelayMessage(v: unknown): v is RelayMessage {
  return (
    isRecord(v) &&
    typeof v.id === 'string' &&
    v.id.length > 0 &&
    v.id.length <= 128 &&
    (v.clientType === 'dapp' || v.clientType === 'wallet') &&
    'message' in v &&
    ((typeof v.message === 'string' && v.message.length <= MAX_RELAY_CIPHERTEXT_CHARS) ||
      isRecord(v.message))
  );
}

/** Wire `type` strings mapped back to the MessageType enum, no assertions. */
const MESSAGE_TYPE_BY_VALUE: Record<string, MessageType | undefined> = Object.fromEntries(
  Object.values(MessageType).map((m) => [m, m])
);

/** Validate a decrypted wire object into a JsonRpcResponse, or null if malformed. */
function parseJsonRpcResponse(msg: Record<string, unknown>): JsonRpcResponse | null {
  if (msg.jsonrpc !== '2.0' || !isValidJsonRpcId(msg.id)) return null;
  const hasResult = Object.prototype.hasOwnProperty.call(msg, 'result');
  const hasError = Object.prototype.hasOwnProperty.call(msg, 'error');
  if (hasResult === hasError) return null;
  const out: JsonRpcResponse = {
    jsonrpc: '2.0',
    id: msg.id,
  };
  if (hasResult) out.result = msg.result;
  if (hasError) {
    const code = isRecord(msg.error) ? msg.error.code : undefined;
    if (
      !isRecord(msg.error) ||
      typeof code !== 'number' ||
      !Number.isSafeInteger(code) ||
      typeof msg.error.message !== 'string' ||
      msg.error.message.length === 0 ||
      msg.error.message.length > MAX_JSON_RPC_ERROR_MESSAGE_CHARS
    ) {
      return null;
    }
    out.error = {
      code,
      message: msg.error.message,
      data: msg.error.data,
    };
  }
  return out;
}

function parsePersistedKex(v: unknown): PersistedSession | null {
  if (!isRecord(v)) return null;
  const { protocolVersion, cid, kAeadRaw, htx, sendDir, recvDir, sendSeq, recvSeq } = v;
  if (
    protocolVersion !== PROTOCOL_VERSION ||
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
    recvSeq < 0 ||
    !isCanonicalBase64OfLength(cid, PERSISTED_CID_LEN) ||
    !isCanonicalBase64OfLength(kAeadRaw, PERSISTED_AEAD_KEY_LEN) ||
    !isCanonicalBase64OfLength(htx, PERSISTED_HTX_LEN) ||
    !isCanonicalBase64OfLength(sendDir, PERSISTED_DIRECTION_LEN) ||
    !isCanonicalBase64OfLength(recvDir, PERSISTED_DIRECTION_LEN) ||
    sendDir !== DAPP_TX_B64 ||
    recvDir !== WALLET_TX_B64
  ) {
    return null;
  }
  return {
    protocolVersion: PROTOCOL_VERSION,
    cid,
    kAeadRaw,
    htx,
    sendDir,
    recvDir,
    sendSeq,
    recvSeq,
  };
}

function parseDAppMetadata(v: unknown): DAppMetadata | null {
  if (
    !isRecord(v) ||
    typeof v.name !== 'string' ||
    v.name.length === 0 ||
    v.name.length > MAX_DAPP_NAME_CHARS ||
    v.name.trim() !== v.name ||
    hasUnsafeDAppNameCharacter(v.name) ||
    typeof v.url !== 'string'
  ) {
    return null;
  }
  const url = canonicalDAppHttpUrl(v.url);
  if (!url) return null;
  const meta: DAppMetadata = { name: v.name, url };
  if (v.icon !== undefined) {
    if (typeof v.icon !== 'string' || v.icon.length > MAX_DAPP_ICON_CHARS) return null;
    meta.icon = v.icon;
  }
  if (v.redirectUrl !== undefined) {
    const redirectUrl = canonicalDAppHttpUrl(v.redirectUrl);
    if (!redirectUrl) return null;
    meta.redirectUrl = redirectUrl;
  }
  return meta;
}

/**
 * Validate raw localStorage JSON into a DAppSession, or null if malformed.
 *
 * Only version 5 is accepted. Versions through 3 cannot prove counter and
 * browser-tab ownership safety. Version 4 has those properties but predates
 * the PQP3 out-of-band capability, so restoring it would retain the relay
 * impersonation weakness. Every older format fails closed into fresh pairing.
 */
function parseStoredSession(raw: string): DAppSession | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(v) || v.version !== 5) return null;
  if (typeof v.channelId !== 'string' || typeof v.chainId !== 'string') return null;
  const parsedChainId = canonicalChainId(v.chainId);
  if (!parsedChainId || parsedChainId !== v.chainId) return null;
  let encodedChannelId: string;
  try {
    encodedChannelId = toBase64(cidFromString(v.channelId));
  } catch {
    return null;
  }
  const now = Date.now();
  if (
    !isBoundedTimestamp(v.createdAt, now) ||
    !isBoundedTimestamp(v.lastActivity, now) ||
    v.lastActivity < v.createdAt
  ) {
    return null;
  }
  const keyExchange = parsePersistedKex(v.keyExchange);
  const dappMetadata = parseDAppMetadata(v.dappMetadata);
  if (
    keyExchange?.cid !== encodedChannelId ||
    !dappMetadata ||
    !isCurrentQrlAddressArray(v.connectedAccounts)
  ) {
    return null;
  }
  return {
    version: 5,
    channelId: v.channelId,
    keyExchange,
    dappMetadata,
    connectedAccounts: v.connectedAccounts,
    chainId: parsedChainId,
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
    const dappMetadata = parseDAppMetadata(options.dappMetadata);
    if (!dappMetadata) throw new Error('Invalid or unbounded dApp metadata');
    const initialChainId = canonicalChainId(options.chainId ?? '0x0');
    if (!initialChainId) throw new Error('Invalid chainId');
    this.dappMetadata = dappMetadata;
    this.relayUrl = normalizeRelayUrl(options.relayUrl ?? DEFAULT_RELAY_URL);
    this.chainId = initialChainId;
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
      void this.handleAutoReconnected(socketClient, result);
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

    socketClient.on('message', (data: unknown) => {
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
      if (data.clientType !== 'wallet') return;
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
    });
  }

  private async handleAutoReconnected(
    socketClient: SocketClient,
    result: JoinResult
  ): Promise<void> {
    if (this.socketClient !== socketClient) return;
    const context = this.captureSessionWorkContext();
    if (context?.socketClient !== socketClient) return;

    // The rejoin acknowledgement is the authoritative tombstone and roster
    // snapshot. Drain its validated backlog before publishing CONNECTED so
    // receive counters are checkpointed first and no frame is lost.
    if (result.terminated) {
      log('ConnectionManager', 'Channel terminated, observed on auto-reconnect');
      this.handleSessionTerminated(true);
      return;
    }
    this.walletPresent = result.participants.includes('wallet');
    for (const message of result.bufferedMessages) {
      this.enqueueRelayMessage(message, context, false);
    }
    await this.messageQueue;
    if (!this.isSessionWorkCurrent(context)) return;

    if (context.keyExchange.areKeysExchanged() && this.walletPresent) {
      this.clearReconnectProbe();
      this.failedReconnects = 0;
      this.setStatus(ConnectionStatus.CONNECTED);
    } else {
      this.setStatus(ConnectionStatus.WAITING);
      if (context.keyExchange.areKeysExchanged()) this.armReconnectProbe();
    }
  }

  private setupKeyExchangeListeners(): void {
    const keyExchange = this.keyExchange;
    const generation = this.sessionGeneration;
    if (!keyExchange) return;
    keyExchange.on('keys_exchanged', () => {
      if (this.keyExchange !== keyExchange || this.sessionGeneration !== generation) return;
      log('ConnectionManager', 'Key exchange complete');
      this.clearReconnectProbe();
      this.walletPresent = true;
      this.failedReconnects = 0;

      // Queue authenticated dApp identity before publishing CONNECTED. Status
      // listeners are synchronous and may immediately call requestAccounts();
      // sendEncrypted's FIFO queue must already contain ORIGINATOR_INFO so the
      // wallet never sees approval-bound JSON-RPC before identity provenance.
      const originatorInfoSend = this.sendEncrypted({
        type: MessageType.ORIGINATOR_INFO,
        originatorInfo: {
          ...this.dappMetadata,
          chainId: this.chainId,
        },
      });
      this.setStatus(ConnectionStatus.CONNECTED);
      void originatorInfoSend.catch((err: unknown) => {
        logError('ConnectionManager', 'Failed to send originator info:', err);
      });
    });
  }

  // ── Public API ─────────────────────────────────────────────

  /**
   * Generate a new v3 connection URI. Rotates channel id, keypair, and the
   * QR-only pairing capability.
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

    // Every URI carries a live bearer capability. Before issuing another one,
    // retire any joined, paired, or restorable channel so an older QR cannot
    // remain usable in the wallet until relay TTL expiry. The conflict retry
    // below skips this because its failed join never established membership.
    if (
      retryOnConflict &&
      (this.socketClient.getChannelId() !== null ||
        this.pendingRestore !== null ||
        this.keyExchange !== null)
    ) {
      await this.resetForNewChannel();
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
    const accountsWereAuthorized = this.connectedAccounts.length > 0;
    this.connectedAccounts = [];
    if (accountsWereAuthorized) this.emit('accounts_changed', []);
    try {
      this.removeStoredSessionOrThrow();
    } catch (err) {
      this.setStatus(ConnectionStatus.DISCONNECTED);
      // A stale v5 record may still be present and this path has not created a
      // relay tombstone. Retain ownership so no second tab can restore that
      // counter stream while this page remains alive.
      throw err;
    }
    this.persistenceBroken = false;
    this.sessionCreatedAt = Date.now();

    this.keyExchange = new KeyExchange(true);
    this.setupKeyExchangeListeners();
    const initiated = this.keyExchange.initiate();
    const pk = initiated.publicKey;
    const capability = initiated.capability;
    let context: SessionWorkContext | null = null;

    try {
      // Always rotate the channel id on fresh QR generation so that relay
      // buffers and participant lists from a prior pairing cannot leak in.
      this.channelId = randomUuid();
      context = this.captureSessionWorkContext();
      if (!context) throw new Error('Failed to initialize QRL Connect session');

      // PQP3 uploads only the KEM public key to the relay. The capability
      // remains in this generation and its eventual QR/deep-link URI.
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
          return await this.getConnectionURI(false);
        }
        // A failed initial join is terminal for this pairing attempt. Stop the
        // Socket.IO retry loop and clear its channel so it cannot auto-rejoin
        // as a ghost participant after the caller received an error.
        this.invalidateSessionWork();
        this.keyExchange = null;
        context.socketClient.leaveChannel();
        context.socketClient.disconnect();
        this.setStatus(ConnectionStatus.DISCONNECTED);
        await this.releaseSessionOwnership();
        throw err;
      }

      this.setStatus(ConnectionStatus.WAITING);

      let uri: string;
      try {
        uri = await generateConnectionURI(
          cidFromString(context.channelId),
          pk,
          capability,
          this.relayUrl === DEFAULT_RELAY_URL ? undefined : this.relayUrl
        );
        this.assertSessionWorkCurrent(context);
      } catch (err) {
        if (this.isSessionWorkCurrent(context)) {
          this.invalidateSessionWork();
          this.keyExchange = null;
          context.socketClient.leaveChannel();
          context.socketClient.disconnect();
          this.setStatus(ConnectionStatus.DISCONNECTED);
          await this.releaseSessionOwnership();
        }
        throw err;
      }
      log('ConnectionManager', `Generated v3 connection URI for channel ${context.channelId}`);
      return uri;
    } catch (err) {
      if (context ? this.isSessionWorkCurrent(context) : this.keyExchange !== null) {
        this.invalidateSessionWork();
        this.keyExchange = null;
        this.socketClient.leaveChannel();
        this.socketClient.disconnect();
        this.setStatus(ConnectionStatus.DISCONNECTED);
        await this.releaseSessionOwnership();
      }
      throw err;
    } finally {
      capability.fill(0);
    }
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
        this.enqueueRelayMessage(msg, context, false);
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
    const accountsWereAuthorized = this.connectedAccounts.length > 0;
    this.connectedAccounts = [];
    if (accountsWereAuthorized) this.emit('accounts_changed', []);
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
    if (!isValidJsonRpcId(request.id)) {
      throw new Error('Invalid JSON-RPC request id');
    }
    if (
      !isValidJsonRpcMethod(request.method) ||
      classifyRpcMethod(request.method) === 'unsupported'
    ) {
      throw new Error('Unsupported JSON-RPC method');
    }
    if (request.params !== undefined && !Array.isArray(request.params)) {
      throw new Error('JSON-RPC params must be an array');
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

  /**
   * Commit accounts returned by an approved qrl_requestAccounts response.
   * WALLET_INFO alone cannot grant this authorization.
   */
  async authorizeAccounts(value: unknown): Promise<string[]> {
    if (!isCurrentQrlAddressArray(value) || value.length === 0) {
      throw new Error('qrl_requestAccounts returned an invalid account list');
    }
    const context = this.captureSessionWorkContext();
    if (!context?.keyExchange.areKeysExchanged()) {
      throw new Error('Cannot authorize accounts without an established session');
    }
    const nextAccounts = [...value];
    const previousAccounts = this.connectedAccounts;
    const changed = !this.areArraysEqual(previousAccounts, nextAccounts);
    this.connectedAccounts = nextAccounts;
    try {
      await this.persistSession(context);
      this.assertSessionWorkCurrent(context);
    } catch (error) {
      if (this.isSessionWorkCurrent(context)) this.connectedAccounts = previousAccounts;
      await this.teardownPersistenceFailedSession(error, context);
      throw error;
    }
    if (changed) this.emit('accounts_changed', [...this.connectedAccounts]);
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
   * Ensure this socket is a relay participant before closing a restorable or
   * temporarily disconnected channel. close_channel is intentionally
   * participant-only on the relay, so a cold stored session cannot be retired
   * by emitting the close event from an unjoined socket.
   */
  private async prepareRelayChannelForRetirement(): Promise<{
    hadRelayChannel: boolean;
    alreadyRetired: boolean;
  }> {
    const socketChannelId = this.socketClient.getChannelId();
    const fallbackChannelId =
      this.pendingRestore !== null || this.keyExchange !== null ? this.channelId : null;
    const channelId = socketChannelId ?? fallbackChannelId;
    if (!channelId) return { hadRelayChannel: false, alreadyRetired: false };

    if (!this.socketClient.isConnected() || socketChannelId !== channelId) {
      this.socketClient.connect();
      const result = await this.socketClient.joinChannel(channelId);
      if (result.terminated) {
        return { hadRelayChannel: true, alreadyRetired: true };
      }
    }
    return { hadRelayChannel: true, alreadyRetired: false };
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

    const retirement = await this.prepareRelayChannelForRetirement();
    let relayRetired = retirement.alreadyRetired;
    try {
      if (!relayRetired) {
        await this.flushTerminate();
        relayRetired = await this.socketClient.closeChannel();
      }
    } catch (err) {
      logError('ConnectionManager', 'Failed to tombstone reset channel:', err);
    }
    if (retirement.hadRelayChannel && !relayRetired) {
      throw new Error('Unable to retire the previous relay channel');
    }

    this.invalidateSessionWork();
    this.socketClient.leaveChannel();
    this.socketClient.disconnect();
    const storageInvalidated = this.clearSession();
    const accountsWereAuthorized = this.connectedAccounts.length > 0;
    this.connectedAccounts = [];
    if (accountsWereAuthorized) this.emit('accounts_changed', []);
    this.pendingRestore = null;
    this.channelId = randomUuid();
    this.keyExchange = null;
    this.persistenceBroken = false;
    this.sessionCreatedAt = Date.now();

    this.socketClient = new SocketClient(this.relayUrl, 'dapp');
    this.setupSocketListeners();

    this.setStatus(ConnectionStatus.DISCONNECTED);
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

    let hadRelayChannel =
      this.socketClient.getChannelId() !== null ||
      this.pendingRestore !== null ||
      this.keyExchange !== null;
    let relayRetired = false;
    try {
      const retirement = await this.prepareRelayChannelForRetirement();
      hadRelayChannel = retirement.hadRelayChannel;
      relayRetired = retirement.alreadyRetired;
      if (hadRelayChannel && !relayRetired) {
        await this.flushTerminate();
        relayRetired = await this.socketClient.closeChannel();
      }
    } catch (err) {
      logError('ConnectionManager', 'Failed to tombstone disconnected channel:', err);
    }
    if (hadRelayChannel && !relayRetired) {
      throw new Error('Unable to retire the relay channel');
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

  private enqueueRelayMessage(
    data: unknown,
    context: SessionWorkContext,
    settleConnection = true
  ): void {
    // Single validation funnel for both live socket messages and relay-buffered
    // backlog: nothing past this point handles an unshaped envelope.
    if (!isRelayMessage(data)) {
      warn('ConnectionManager', 'Dropping malformed relay envelope');
      return;
    }
    if (data.id !== context.channelId || data.clientType !== 'wallet') {
      warn('ConnectionManager', 'Dropping relay envelope for the wrong channel or peer role');
      return;
    }
    // Chain with .catch so that a single failing handler (tag-fail,
    // malformed JSON) does not leave the queue in a rejected state and
    // silently starve every subsequent message on the channel.
    this.messageQueue = this.messageQueue
      .then(() => this.handleRelayMessage(data, context))
      .then(() => {
        if (
          settleConnection &&
          this.isSessionWorkCurrent(context) &&
          context.keyExchange.areKeysExchanged() &&
          this.walletPresent
        ) {
          this.failedReconnects = 0;
          this.setStatus(ConnectionStatus.CONNECTED);
        }
      })
      .catch((err: unknown) => {
        logError('ConnectionManager', 'messageQueue handler error:', err);
      });
  }

  private async handleRelayMessage(data: RelayMessage, context: SessionWorkContext): Promise<void> {
    if (!this.isSessionWorkCurrent(context)) return;
    this.walletPresent = true;
    this.clearReconnectProbe();

    const message = data.message;

    if (isRecord(message)) {
      if (message.type === KeyExchangeMessageType.SYNACK) {
        if (
          isCanonicalBase64OfLength(message.ct, ML_KEM_768_CT_LEN) &&
          isCanonicalBase64OfLength(message.c0, SYNACK_C0_LEN)
        ) {
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
      try {
        await this.sendPlaintext(response, context);
        this.assertSessionWorkCurrent(context);
        context.keyExchange.confirmOriginatorAckDelivered();
      } catch (err) {
        if (!this.isSessionWorkCurrent(context)) return;
        const error = err instanceof Error ? err : new Error(String(err));
        logError('ConnectionManager', 'ACK delivery failed; retiring provisional session:', error);
        this.emit('error', error);
        let relayRetired = false;
        try {
          relayRetired = await context.socketClient.closeChannel();
        } catch (closeError) {
          logError('ConnectionManager', 'Failed to tombstone ambiguous handshake:', closeError);
        }
        if (this.isSessionWorkCurrent(context)) this.handleSessionTerminated(relayRetired);
      }
      return;
    }
    // Duplicate SYNACK: the wallet re-sent it because it never saw our ACK
    // (its socket flapped right after SYNACK). Re-send the cached ACK so the
    // wallet can finalize; the bytes are deterministic and the wallet's
    // onAck is idempotent.
    const cachedAck = context.keyExchange.getLastAck();
    if (context.keyExchange.areKeysExchanged() && cachedAck) {
      log('ConnectionManager', 'Duplicate SYNACK after handshake; re-sending cached ACK');
      try {
        await this.sendPlaintext(cachedAck, context);
      } catch (err) {
        logError('ConnectionManager', 'Failed to re-send cached ACK:', err);
      }
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
        const reportedAccounts = [...msg.accounts];
        // WALLET_INFO is presence/metadata, not an approval result. It may
        // preserve the exact account already authorized for this session, but
        // it cannot upgrade an empty cache or silently switch to another one.
        const nextAccounts =
          this.connectedAccounts.length > 0 &&
          this.areArraysEqual(this.connectedAccounts, reportedAccounts)
            ? this.connectedAccounts
            : [];
        let nextChainId = this.chainId;
        if (msg.chainId !== undefined) {
          const parsedChainId = canonicalChainId(msg.chainId);
          if (!parsedChainId || parsedChainId !== msg.chainId) {
            warn('ConnectionManager', 'Dropping wallet info with malformed chain id');
            break;
          }
          nextChainId = parsedChainId;
        }
        const accountsChanged = !this.areArraysEqual(this.connectedAccounts, nextAccounts);
        const chainChanged = this.chainId !== nextChainId;

        this.connectedAccounts = [...nextAccounts];
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

  private async sendPlaintext(
    message: object,
    context = this.captureSessionWorkContext()
  ): Promise<void> {
    if (!context || !this.isSessionWorkCurrent(context)) {
      throw new Error('Cannot send plaintext for a retired session');
    }
    await context.socketClient.sendMessage({
      id: context.channelId,
      clientType: 'dapp',
      message,
    });
    this.assertSessionWorkCurrent(context);
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
    let encrypted: string;
    try {
      encrypted = await context.keyExchange.encryptMessage(JSON.stringify(message));
    } catch (err) {
      // encryptMessage reserves sendSeq synchronously before WebCrypto. Any
      // later seal failure leaves a permanent counter gap, so this generation
      // cannot safely send another ciphertext.
      await this.teardownPersistenceFailedSession(
        err,
        context,
        'Message encryption failed after counter reservation; terminating session'
      );
      throw err;
    }
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
      version: 5,
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
