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
} from './config.js';
import { cidFromString, generateConnectionURI } from './utils/qrUri.js';
import { toBase64 } from './PQCrypto.js';
import { randomUuid } from './crypto/primitives.js';
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

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
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
    !Number.isInteger(sendSeq) ||
    sendSeq < 0 ||
    typeof recvSeq !== 'number' ||
    !Number.isInteger(recvSeq) ||
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
 * Only version 3 is accepted. v2 sessions persisted the AEAD counters at
 * sparse checkpoints (handshake + wallet_info), so a restored v2 session
 * could resume with a stale sendSeq and reuse an AES-256-GCM nonce under the
 * same key. v3 checkpoints the counters on every seal/open; older records
 * fail closed into a fresh pairing.
 */
function parseStoredSession(raw: string): DAppSession | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(v) || v.version !== 3) return null;
  if (typeof v.channelId !== 'string' || typeof v.chainId !== 'string') return null;
  if (typeof v.createdAt !== 'number' || typeof v.lastActivity !== 'number') return null;
  const keyExchange = parsePersistedKex(v.keyExchange);
  const dappMetadata = parseDAppMetadata(v.dappMetadata);
  if (!keyExchange || !dappMetadata || !isStringArray(v.connectedAccounts)) return null;
  return {
    version: 3,
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
  error: (error: Error) => void;
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
  private failedReconnects = 0;
  private walletPresent = false;
  private pendingRestore: DAppSession | null = null;
  private messageQueue: Promise<void> = Promise.resolve();
  private static MAX_RECONNECT_FAILURES = 5;

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

    const stored = this.readStoredSession();
    if (stored) {
      this.channelId = stored.channelId;
      this.connectedAccounts = stored.connectedAccounts;
      this.chainId = stored.chainId;
      this.dappMetadata = stored.dappMetadata;
      this.pendingRestore = stored;
      log('ConnectionManager', `Found persisted session for channel ${this.channelId}`);
    } else {
      this.channelId = randomUuid();
    }

    this.socketClient = new SocketClient(this.relayUrl, 'dapp');
    this.setupSocketListeners();
  }

  // ── Setup ──────────────────────────────────────────────────

  private setupSocketListeners(): void {
    this.socketClient.on('connected', () => {
      if (this.status === ConnectionStatus.RECONNECTING) {
        this.failedReconnects = 0;
      }
    });

    this.socketClient.on('reconnected', (result) => {
      // The re-join ack tells us, fresh, whether the channel was explicitly
      // terminated and whether the wallet is still present. The preceding
      // 'disconnected' cleared walletPresent, so without re-deriving it here
      // an idle-but-present wallet looks absent and the probe would tear down
      // a healthy session (and a tombstone would be ignored on auto-reconnect).
      if (result?.terminated) {
        log('ConnectionManager', 'Channel terminated, observed on auto-reconnect');
        this.handleSessionTerminated();
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

    this.socketClient.on('disconnected', () => {
      this.walletPresent = false;
      if (this.status === ConnectionStatus.CONNECTED) {
        this.setStatus(ConnectionStatus.RECONNECTING);
        this.failedReconnects++;
        if (this.failedReconnects >= ConnectionManager.MAX_RECONNECT_FAILURES) {
          this.emit('connection_lost');
        }
      }
    });

    this.socketClient.on('message', (data: RelayMessage) => {
      this.enqueueRelayMessage(data);
    });

    this.socketClient.on('error', (err) => {
      this.emit('error', err);
    });

    this.socketClient.on('participants_changed', (data) => {
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
        this.handleSessionTerminated();
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
    if (!this.keyExchange) return;
    this.keyExchange.on('keys_exchanged', () => {
      log('ConnectionManager', 'Key exchange complete');
      this.clearReconnectProbe();
      this.setStatus(ConnectionStatus.CONNECTED);
      this.walletPresent = true;
      this.failedReconnects = 0;
      void this.persistSession();
      void this.sendEncrypted({
        type: MessageType.ORIGINATOR_INFO,
        originatorInfo: {
          ...this.dappMetadata,
          chainId: this.chainId,
        },
      });
    });
  }

  // ── Public API ─────────────────────────────────────────────

  /**
   * Generate a new v2 connection URI. Rotates channel id and keypair.
   * Returns a `qrlconnect://?q=…` URI safe for QR-rendering or deep-link.
   */
  async getConnectionURI(retryOnConflict = true): Promise<string> {
    this.setStatus(ConnectionStatus.CONNECTING);
    this.clearReconnectProbe();
    this.pendingRestore = null;
    this.walletPresent = false;

    if (this.keyExchange) {
      this.keyExchange.reset();
    } else {
      this.keyExchange = new KeyExchange(true);
      this.setupKeyExchangeListeners();
    }
    const pk = this.keyExchange.initiate();

    // Always rotate the channel id on fresh QR generation so that relay
    // buffers and participant lists from a prior pairing cannot leak in.
    this.channelId = randomUuid();

    // v2 protocol: upload the KEM public key to the relay before joining
    // so the relay can bind it to the channel and serve it back to the
    // wallet on its join_channel ack. The wallet verifies it against the
    // fingerprint carried in the QR - the PK itself is no longer in the QR.
    this.socketClient.setPublicKey(toBase64(pk));

    this.socketClient.connect();
    try {
      await this.socketClient.joinChannel(this.channelId);
    } catch (err) {
      if (retryOnConflict && this.isDappParticipantConflictError(err)) {
        warn(
          'ConnectionManager',
          'Channel already has an active dApp participant. Rotating to a fresh channel.'
        );
        this.channelId = randomUuid();
        return this.getConnectionURI(false);
      }
      this.setStatus(ConnectionStatus.DISCONNECTED);
      throw err;
    }

    this.setStatus(ConnectionStatus.WAITING);

    const uri = await generateConnectionURI(
      cidFromString(this.channelId),
      pk,
      this.relayUrl === DEFAULT_RELAY_URL ? undefined : this.relayUrl
    );
    log('ConnectionManager', `Generated v2 connection URI for channel ${this.channelId}`);
    return uri;
  }

  /**
   * Reconnect to an existing session.
   * Returns false if there is nothing to restore.
   */
  async reconnect(): Promise<boolean> {
    if (!this.pendingRestore) return false;

    this.setStatus(ConnectionStatus.RECONNECTING);
    this.walletPresent = false;

    try {
      const session = await KeyExchange.sessionFromPersisted(this.pendingRestore.keyExchange);
      this.keyExchange = new KeyExchange(true, session);
      this.setupKeyExchangeListeners();
    } catch (err) {
      logError('ConnectionManager', 'Failed to hydrate persisted session:', err);
      this.clearSession();
      this.pendingRestore = null;
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
    this.socketClient.connect();
    try {
      const { bufferedMessages, participants, terminated } = await this.socketClient.joinChannel(
        this.channelId
      );

      // The channel was explicitly closed (wallet/app forgot us). Drop the
      // stored session instead of waiting on a wallet that will never return.
      if (terminated) {
        log('ConnectionManager', 'Stored session was terminated by the wallet; dropping it');
        this.handleSessionTerminated();
        return false;
      }

      // Relay roster lets us know up front whether the wallet is present,
      // rather than relying on a future participants_changed event.
      if (participants.includes('wallet')) {
        this.walletPresent = true;
      }

      for (const msg of bufferedMessages) {
        this.enqueueRelayMessage(msg);
      }
      await this.messageQueue;

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
   * A session was terminated for good (wallet sent a relay 'close', or the
   * join ack reported a tombstone). Clear local state and surface
   * DISCONNECTED so the consumer drops to a fresh-pairing UI.
   */
  private handleSessionTerminated(): void {
    this.clearReconnectProbe();
    this.clearUnresponsiveTimer();
    this.walletPresent = false;
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
    this.clearSession();
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
   * Send a JSON-RPC request to the wallet (async, fire-and-forget).
   */
  sendJsonRpc(request: JsonRpcRequest): void {
    if (!this.keyExchange?.areKeysExchanged()) {
      throw new Error('Not connected: key exchange not complete');
    }
    this.sendEncrypted({
      type: MessageType.JSONRPC,
      jsonrpc: '2.0',
      id: request.id,
      method: request.method,
      params: request.params,
    }).catch((err: unknown) => {
      logError('ConnectionManager', 'Failed to send JSON-RPC:', err);
    });
    this.startUnresponsiveTimer();
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }
  getAccounts(): string[] {
    return this.connectedAccounts;
  }
  getChainId(): string {
    return this.chainId;
  }
  getChannelId(): string {
    return this.channelId;
  }

  /** Check (sync) if a persisted session exists and has not expired. */
  hasStoredSession(): boolean {
    if (typeof localStorage === 'undefined') return false;
    try {
      const raw = localStorage.getItem(this.storageKey);
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

    this.socketClient.leaveChannel();
    this.socketClient.disconnect();
    this.clearSession();
    this.connectedAccounts = [];
    this.pendingRestore = null;
    this.channelId = randomUuid();
    this.keyExchange = null;

    this.socketClient = new SocketClient(this.relayUrl, 'dapp');
    this.setupSocketListeners();

    this.setStatus(ConnectionStatus.DISCONNECTED);
  }

  async disconnect(): Promise<void> {
    this.clearUnresponsiveTimer();
    this.clearReconnectProbe();
    this.walletPresent = false;

    await this.flushTerminate();

    this.socketClient.leaveChannel();
    this.socketClient.disconnect();
    this.setStatus(ConnectionStatus.DISCONNECTED);
    this.clearSession();
    this.connectedAccounts = [];
    // Fully terminate the session: without clearing these, a later
    // visibilitychange/online resume() would re-open the socket and re-join
    // the channel after an explicit disconnect.
    this.pendingRestore = null;
    this.keyExchange = null;
  }

  // ── Internals ──────────────────────────────────────────────

  private enqueueRelayMessage(data: unknown): void {
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
      .then(() => this.handleRelayMessage(data))
      .catch((err: unknown) => {
        logError('ConnectionManager', 'messageQueue handler error:', err);
      });
  }

  private async handleRelayMessage(data: RelayMessage): Promise<void> {
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
          await this.handleSynAck({
            type: KeyExchangeMessageType.SYNACK,
            ct: message.ct,
            c0: message.c0,
            v: typeof message.v === 'number' ? message.v : 0,
          });
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

    if (typeof message === 'string' && this.keyExchange?.areKeysExchanged()) {
      try {
        const decrypted = await this.keyExchange.decryptMessage(message);
        // The AEAD counters advanced; checkpoint them before acting on the
        // plaintext so a reload cannot restore a stale recvSeq and reopen a
        // replay window for ciphertexts the relay has already delivered.
        await this.persistSession();
        const parsed: unknown = JSON.parse(decrypted);
        if (isRecord(parsed)) {
          this.handleDecryptedMessage(parsed);
        } else {
          warn('ConnectionManager', 'Dropping non-object decrypted payload');
        }
      } catch (err) {
        logError('ConnectionManager', 'Failed to decrypt message:', err);
      }
    }
  }

  private async handleSynAck(msg: SynAckMessage): Promise<void> {
    if (!this.keyExchange) return;
    this.setStatus(ConnectionStatus.KEY_EXCHANGE);

    let response: AckMessage | null;
    try {
      response = await this.keyExchange.onSynAck(cidFromString(this.channelId), msg);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      logError('ConnectionManager', 'SYNACK processing failed:', e);
      this.emit('error', e);
      return;
    }
    if (response) {
      this.sendPlaintext(response);
    }
  }

  private handleDecryptedMessage(msg: Record<string, unknown>): void {
    this.clearUnresponsiveTimer();

    const type = typeof msg.type === 'string' ? msg.type : '';

    switch (MESSAGE_TYPE_BY_VALUE[type]) {
      case MessageType.WALLET_INFO: {
        const nextAccounts = isStringArray(msg.accounts) ? msg.accounts : [];
        const nextChainId =
          typeof msg.chainId === 'string' && msg.chainId ? msg.chainId : this.chainId;
        const accountsChanged = !this.areArraysEqual(this.connectedAccounts, nextAccounts);
        const chainChanged = this.chainId !== nextChainId;

        this.connectedAccounts = nextAccounts;
        this.chainId = nextChainId;
        void this.persistSession();
        this.emit('wallet_info', {
          accounts: this.connectedAccounts,
          chainId: this.chainId,
        });
        if (accountsChanged) this.emit('accounts_changed', this.connectedAccounts);
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
        // fire-and-forget here: we received the wallet's TERMINATE, we
        // don't need to round-trip another one back at them.
        void this.disconnect();
        break;
      }

      default:
        log('ConnectionManager', `Unhandled message type: ${type}`);
    }
  }

  private sendPlaintext(message: object): void {
    this.socketClient
      .sendMessage({
        id: this.channelId,
        clientType: 'dapp',
        message,
      })
      .catch((err: unknown) => {
        logError('ConnectionManager', 'Failed to send plaintext:', err);
      });
  }

  private async sendEncrypted(message: object): Promise<void> {
    if (!this.keyExchange?.areKeysExchanged()) {
      throw new Error('sendEncrypted: not connected');
    }
    const encrypted = await this.keyExchange.encryptMessage(JSON.stringify(message));
    // Checkpoint the advanced sendSeq BEFORE the ciphertext can reach the
    // relay. If we crash in between, the stored counter is ahead (the wallet
    // drops the gap and the session dies cleanly); persisting after the send
    // could leave it behind, and a restored stale sendSeq would reuse an
    // AES-256-GCM nonce under the same key.
    await this.persistSession();
    await this.socketClient.sendMessage({
      id: this.channelId,
      clientType: 'dapp',
      message: encrypted,
    });
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

  private async persistSession(): Promise<void> {
    if (typeof localStorage === 'undefined') return;
    if (!this.keyExchange) return;
    const persistedKex = await this.keyExchange.exportPersisted();
    if (!persistedKex) return;

    const session: DAppSession = {
      version: 3,
      channelId: this.channelId,
      keyExchange: persistedKex,
      dappMetadata: this.dappMetadata,
      connectedAccounts: this.connectedAccounts,
      chainId: this.chainId,
      createdAt: this.pendingRestore?.createdAt ?? Date.now(),
      lastActivity: Date.now(),
    };

    try {
      localStorage.setItem(this.storageKey, JSON.stringify(session));
    } catch (err) {
      warn('ConnectionManager', 'localStorage.setItem failed:', err);
    }
  }

  private readStoredSession(): DAppSession | null {
    if (typeof localStorage === 'undefined') return null;
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return null;
      const session = parseStoredSession(raw);
      if (!session) {
        // Legacy (pre-v3) or malformed record: clear to force a fresh pairing.
        log('ConnectionManager', 'Dropping legacy or malformed session from storage');
        localStorage.removeItem(this.storageKey);
        return null;
      }
      if (Date.now() - session.createdAt > SESSION_TTL_MS) {
        localStorage.removeItem(this.storageKey);
        return null;
      }
      return session;
    } catch {
      return null;
    }
  }

  private clearSession(): void {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(this.storageKey);
  }
}
