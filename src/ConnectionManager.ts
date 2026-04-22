/**
 * Connection Manager — orchestrates socket lifecycle, the post-quantum
 * handshake, encrypted message routing, and session persistence for the
 * dApp side of QRL Connect v2.
 */

import EventEmitter from 'eventemitter3';
import { v4 as uuidv4 } from 'uuid';
import { KeyExchange, type AckMessage, type SynAckMessage } from './KeyExchange.js';
import { SocketClient } from './SocketClient.js';
import {
  DEFAULT_RELAY_URL,
  STORAGE_KEY_PREFIX,
  SESSION_TTL_MS,
  WALLET_UNRESPONSIVE_MS,
} from './config.js';
import { cidFromString, generateConnectionURI } from './utils/qrUri.js';
import { toBase64 } from './PQCrypto.js';
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
  private failedReconnects = 0;
  private walletPresent = false;
  private pendingRestore: DAppSession | null = null;
  private messageQueue: Promise<void> = Promise.resolve();
  private static MAX_RECONNECT_FAILURES = 5;

  constructor(options: {
    dappMetadata: DAppMetadata;
    relayUrl?: string;
    chainId?: string;
    storageKey?: string;
  }) {
    super();
    this.dappMetadata = options.dappMetadata;
    this.relayUrl = options.relayUrl || DEFAULT_RELAY_URL;
    this.chainId = options.chainId || '0x0';
    this.storageKey = options.storageKey || `${STORAGE_KEY_PREFIX}:session`;

    const stored = this.readStoredSession();
    if (stored) {
      this.channelId = stored.channelId;
      this.connectedAccounts = stored.connectedAccounts;
      this.chainId = stored.chainId;
      this.dappMetadata = stored.dappMetadata;
      this.pendingRestore = stored;
      log('ConnectionManager', `Found persisted session for channel ${this.channelId}`);
    } else {
      this.channelId = uuidv4();
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

    this.socketClient.on('reconnected', () => {
      if (this.keyExchange?.areKeysExchanged()) {
        if (this.walletPresent) {
          this.setStatus(ConnectionStatus.CONNECTED);
          this.failedReconnects = 0;
        } else {
          this.setStatus(ConnectionStatus.WAITING);
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
        if (this.keyExchange?.areKeysExchanged()) {
          this.failedReconnects = 0;
          this.setStatus(ConnectionStatus.CONNECTED);
        }
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
    this.channelId = uuidv4();

    // v2 protocol: upload the KEM public key to the relay before joining
    // so the relay can bind it to the channel and serve it back to the
    // wallet on its join_channel ack. The wallet verifies it against the
    // fingerprint carried in the QR — the PK itself is no longer in the QR.
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
        this.channelId = uuidv4();
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

    this.socketClient.connect();
    try {
      const { bufferedMessages } = await this.socketClient.joinChannel(this.channelId);
      for (const msg of bufferedMessages) {
        this.enqueueRelayMessage(msg as RelayMessage);
      }
      await this.messageQueue;

      if (this.keyExchange?.areKeysExchanged()) {
        this.setStatus(this.walletPresent ? ConnectionStatus.CONNECTED : ConnectionStatus.WAITING);
      } else {
        this.setStatus(ConnectionStatus.WAITING);
      }
      return true;
    } catch (err) {
      logError('ConnectionManager', 'Reconnect failed:', err);
      this.setStatus(ConnectionStatus.DISCONNECTED);
      return false;
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
    }).catch((err) => {
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
      const session = JSON.parse(raw) as DAppSession;
      if (session.version !== 2) return false;
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
    const send = this.sendEncrypted({ type: MessageType.TERMINATE }).catch(() => {});
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
    this.walletPresent = false;

    await this.flushTerminate();

    this.socketClient.leaveChannel();
    this.socketClient.disconnect();
    this.clearSession();
    this.connectedAccounts = [];
    this.pendingRestore = null;
    this.channelId = uuidv4();
    this.keyExchange = null;

    this.socketClient = new SocketClient(this.relayUrl, 'dapp');
    this.setupSocketListeners();

    this.setStatus(ConnectionStatus.DISCONNECTED);
  }

  async disconnect(): Promise<void> {
    this.clearUnresponsiveTimer();
    this.walletPresent = false;

    await this.flushTerminate();

    this.socketClient.leaveChannel();
    this.socketClient.disconnect();
    this.setStatus(ConnectionStatus.DISCONNECTED);
    this.clearSession();
    this.connectedAccounts = [];
  }

  // ── Internals ──────────────────────────────────────────────

  private enqueueRelayMessage(data: RelayMessage): void {
    // Chain with .catch so that a single failing handler (tag-fail,
    // malformed JSON) does not leave the queue in a rejected state and
    // silently starve every subsequent message on the channel.
    this.messageQueue = this.messageQueue
      .then(() => this.handleRelayMessage(data))
      .catch((err) => logError('ConnectionManager', 'messageQueue handler error:', err));
  }

  private async handleRelayMessage(data: RelayMessage): Promise<void> {
    if (data.clientType === 'wallet') {
      this.walletPresent = true;
      if (this.keyExchange?.areKeysExchanged() && this.status !== ConnectionStatus.CONNECTED) {
        this.failedReconnects = 0;
        this.setStatus(ConnectionStatus.CONNECTED);
      }
    }

    const message = data.message;

    if (typeof message === 'object' && message !== null) {
      const msg = message as { type?: string };
      if (msg.type === KeyExchangeMessageType.SYNACK) {
        await this.handleSynAck(message as SynAckMessage);
        return;
      }
      if (msg.type === KeyExchangeMessageType.SYN || msg.type === KeyExchangeMessageType.ACK) {
        warn('ConnectionManager', `Unexpected ${msg.type} on dApp side — ignoring`);
        return;
      }
    }

    if (typeof message === 'string' && this.keyExchange?.areKeysExchanged()) {
      try {
        const decrypted = await this.keyExchange.decryptMessage(message);
        const parsed = JSON.parse(decrypted) as Record<string, unknown>;
        this.handleDecryptedMessage(parsed);
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

    const type = msg.type as string;

    switch (type) {
      case MessageType.WALLET_INFO: {
        const info = msg as unknown as {
          accounts: string[];
          chainId: string;
        };
        const nextAccounts = info.accounts || [];
        const nextChainId = info.chainId || this.chainId;
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
        const response = msg as unknown as JsonRpcResponse;
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
      .catch((err) => {
        logError('ConnectionManager', 'Failed to send plaintext:', err);
      });
  }

  private async sendEncrypted(message: object): Promise<void> {
    if (!this.keyExchange?.areKeysExchanged()) {
      throw new Error('sendEncrypted: not connected');
    }
    const encrypted = await this.keyExchange.encryptMessage(JSON.stringify(message));
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
      version: 2,
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
      const session = JSON.parse(raw) as Partial<DAppSession>;
      if (session.version !== 2) {
        // v1 → clear to force a fresh pairing on v2.
        log('ConnectionManager', 'Dropping legacy (pre-v2) session from storage');
        localStorage.removeItem(this.storageKey);
        return null;
      }
      if (!session.createdAt || Date.now() - session.createdAt > SESSION_TTL_MS) {
        localStorage.removeItem(this.storageKey);
        return null;
      }
      return session as DAppSession;
    } catch {
      return null;
    }
  }

  private clearSession(): void {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(this.storageKey);
  }
}
