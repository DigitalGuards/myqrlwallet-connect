/**
 * Connection Manager - Orchestrates socket connection, key exchange,
 * and encrypted message routing. Manages session persistence and reconnection.
 */

import EventEmitter from 'eventemitter3';
import { v4 as uuidv4 } from 'uuid';
import { ECIESClient } from './ECIESClient.js';
import { KeyExchange } from './KeyExchange.js';
import { SocketClient } from './SocketClient.js';
import {
  DEFAULT_RELAY_URL,
  STORAGE_KEY_PREFIX,
  SESSION_TTL_MS,
  WALLET_UNRESPONSIVE_MS,
} from './config.js';
import { generateConnectionURI } from './utils/qrUri.js';
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
  private ecies: ECIESClient;
  private keyExchange: KeyExchange;
  private status: ConnectionStatus = ConnectionStatus.DISCONNECTED;
  private channelId: string;
  private dappMetadata: DAppMetadata;
  private chainId: string;
  private relayUrl: string;
  private connectedAccounts: string[] = [];
  private storageKey: string;
  private unresponsiveTimer: ReturnType<typeof setTimeout> | null = null;
  private failedReconnects = 0;
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
    this.chainId = options.chainId || '0x0'; // Default Zond chain
    this.storageKey = options.storageKey || `${STORAGE_KEY_PREFIX}:session`;

    // Try to restore existing session
    const session = this.loadSession();

    if (session) {
      this.channelId = session.channelId;
      this.ecies = new ECIESClient(session.privateKey);
      this.keyExchange = new KeyExchange(
        this.ecies,
        true, // dApp is always originator
        session.otherPublicKey || undefined
      );
      this.connectedAccounts = session.connectedAccounts;
      log('ConnectionManager', `Restored session for channel ${this.channelId}`);
    } else {
      this.channelId = uuidv4();
      this.ecies = new ECIESClient();
      this.keyExchange = new KeyExchange(this.ecies, true);
    }

    this.socketClient = new SocketClient(this.relayUrl, 'dapp');
    this.setupSocketListeners();
    this.setupKeyExchangeListeners();
  }

  private setupSocketListeners(): void {
    this.socketClient.on('connected', () => {
      if (this.status === ConnectionStatus.RECONNECTING) {
        this.failedReconnects = 0;
        log('ConnectionManager', 'Reconnected to relay');
      }
    });

    this.socketClient.on('reconnected', () => {
      // If keys were already exchanged, we're fully reconnected
      if (this.keyExchange.areKeysExchanged()) {
        this.setStatus(ConnectionStatus.CONNECTED);
        this.failedReconnects = 0;
      }
    });

    this.socketClient.on('disconnected', (reason) => {
      if (this.status === ConnectionStatus.CONNECTED) {
        this.setStatus(ConnectionStatus.RECONNECTING);
        this.failedReconnects++;

        if (this.failedReconnects >= ConnectionManager.MAX_RECONNECT_FAILURES) {
          this.emit('connection_lost');
        }
      }
    });

    this.socketClient.on('message', (data: RelayMessage) => {
      this.handleRelayMessage(data);
    });

    this.socketClient.on('participants_changed', (data) => {
      if (data.event === 'join' && data.clientType === 'wallet') {
        log('ConnectionManager', 'Wallet joined channel');
        this.clearUnresponsiveTimer();
      }
      if (data.event === 'disconnect' || data.event === 'leave') {
        log('ConnectionManager', 'Wallet left channel');
      }
    });
  }

  private setupKeyExchangeListeners(): void {
    this.keyExchange.on('keys_exchanged', () => {
      log('ConnectionManager', 'Key exchange complete');
      this.setStatus(ConnectionStatus.CONNECTED);
      this.saveSession();

      // Send originator info
      this.sendEncrypted({
        type: MessageType.ORIGINATOR_INFO,
        originatorInfo: {
          ...this.dappMetadata,
          chainId: this.chainId,
        },
      });
    });
  }

  /**
   * Generate the connection URI and start listening for wallet connection.
   */
  async getConnectionURI(): Promise<string> {
    this.setStatus(ConnectionStatus.CONNECTING);

    // Connect to relay and join channel
    this.socketClient.connect();
    await this.socketClient.joinChannel(this.channelId);

    this.setStatus(ConnectionStatus.WAITING);

    const uri = generateConnectionURI({
      channelId: this.channelId,
      pubKey: this.ecies.getPublicKey(),
      name: this.dappMetadata.name,
      url: this.dappMetadata.url,
      icon: this.dappMetadata.icon,
      chainId: this.chainId,
      relayUrl: this.relayUrl,
    });

    log('ConnectionManager', `Generated connection URI for channel ${this.channelId}`);
    return uri;
  }

  /**
   * Reconnect to an existing session.
   */
  async reconnect(): Promise<boolean> {
    const session = this.loadSession();
    if (!session) return false;

    this.setStatus(ConnectionStatus.RECONNECTING);
    this.socketClient.connect();

    try {
      const { bufferedMessages } = await this.socketClient.joinChannel(this.channelId);

      // Process buffered messages
      for (const msg of bufferedMessages) {
        this.handleRelayMessage(msg as RelayMessage);
      }

      if (this.keyExchange.areKeysExchanged()) {
        this.setStatus(ConnectionStatus.CONNECTED);
      }

      return true;
    } catch (err) {
      logError('ConnectionManager', 'Reconnect failed:', err);
      this.setStatus(ConnectionStatus.DISCONNECTED);
      return false;
    }
  }

  /**
   * Send a JSON-RPC request to the wallet.
   */
  sendJsonRpc(request: JsonRpcRequest): void {
    if (!this.keyExchange.areKeysExchanged()) {
      throw new Error('Not connected: key exchange not complete');
    }

    this.sendEncrypted({
      type: MessageType.JSONRPC,
      jsonrpc: '2.0',
      id: request.id,
      method: request.method,
      params: request.params,
    });

    // Start unresponsive timer
    this.startUnresponsiveTimer();
  }

  /**
   * Handle an incoming relay message.
   */
  private handleRelayMessage(data: RelayMessage): void {
    const message = data.message;

    // Key exchange messages come as plaintext objects
    if (typeof message === 'object' && message !== null) {
      const msg = message as { type?: string; pubkey?: string; v?: number };
      if (
        msg.type === KeyExchangeMessageType.SYN ||
        msg.type === KeyExchangeMessageType.SYNACK ||
        msg.type === KeyExchangeMessageType.ACK
      ) {
        this.handleKeyExchangeMessage(msg as {
          type: KeyExchangeMessageType;
          pubkey?: string;
          v?: number;
        });
        return;
      }
    }

    // Encrypted messages come as base64 strings
    if (typeof message === 'string' && this.keyExchange.areKeysExchanged()) {
      try {
        const decrypted = this.keyExchange.decryptMessage(message);
        const parsed = JSON.parse(decrypted);
        this.handleDecryptedMessage(parsed);
      } catch (err) {
        logError('ConnectionManager', 'Failed to decrypt message:', err);
      }
    }
  }

  private handleKeyExchangeMessage(msg: {
    type: KeyExchangeMessageType;
    pubkey?: string;
    v?: number;
  }): void {
    this.setStatus(ConnectionStatus.KEY_EXCHANGE);

    const response = this.keyExchange.onMessage(msg);
    if (response) {
      // Send key exchange response as plaintext (not encrypted)
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
        this.connectedAccounts = info.accounts || [];
        this.chainId = info.chainId || this.chainId;
        this.saveSession();
        this.emit('wallet_info', {
          accounts: this.connectedAccounts,
          chainId: this.chainId,
        });
        this.emit('accounts_changed', this.connectedAccounts);
        break;
      }

      case MessageType.JSONRPC: {
        const response = msg as unknown as JsonRpcResponse;
        this.emit('jsonrpc_response', response);
        break;
      }

      case MessageType.TERMINATE: {
        log('ConnectionManager', 'Received terminate from wallet');
        this.disconnect();
        break;
      }

      default:
        log('ConnectionManager', `Unhandled message type: ${type}`);
    }
  }

  /** Send a plaintext (unencrypted) message through the relay. */
  private sendPlaintext(message: object): void {
    this.socketClient.sendMessage({
      id: this.channelId,
      clientType: 'dapp',
      message: message,
    }).catch((err) => {
      logError('ConnectionManager', 'Failed to send plaintext:', err);
    });
  }

  /** Send an encrypted message through the relay. */
  private sendEncrypted(message: object): void {
    try {
      const encrypted = this.keyExchange.encryptMessage(JSON.stringify(message));
      this.socketClient.sendMessage({
        id: this.channelId,
        clientType: 'dapp',
        message: encrypted,
      }).catch((err) => {
        logError('ConnectionManager', 'Failed to send encrypted:', err);
      });
    } catch (err) {
      logError('ConnectionManager', 'Encryption failed:', err);
    }
  }

  private startUnresponsiveTimer(): void {
    this.clearUnresponsiveTimer();
    this.unresponsiveTimer = setTimeout(() => {
      warn('ConnectionManager', 'Wallet appears unresponsive');
      // Don't reject promises - wallet may still respond when foregrounded
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

  /** Disconnect and clean up. */
  disconnect(): void {
    this.clearUnresponsiveTimer();

    // Send terminate to wallet
    if (this.keyExchange.areKeysExchanged()) {
      try {
        this.sendEncrypted({ type: MessageType.TERMINATE });
      } catch {
        // Best effort
      }
    }

    this.socketClient.leaveChannel();
    this.socketClient.disconnect();
    this.setStatus(ConnectionStatus.DISCONNECTED);
    this.clearSession();
    this.connectedAccounts = [];
  }

  // --- Session persistence ---

  private saveSession(): void {
    if (typeof localStorage === 'undefined') return;

    const session: DAppSession = {
      channelId: this.channelId,
      privateKey: this.ecies.getPrivateKeyHex(),
      otherPublicKey: this.keyExchange.getOtherPublicKey(),
      dappMetadata: this.dappMetadata,
      connectedAccounts: this.connectedAccounts,
      chainId: this.chainId,
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };

    localStorage.setItem(this.storageKey, JSON.stringify(session));
  }

  private loadSession(): DAppSession | null {
    if (typeof localStorage === 'undefined') return null;

    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return null;

      const session: DAppSession = JSON.parse(raw);

      // Check TTL
      if (Date.now() - session.createdAt > SESSION_TTL_MS) {
        this.clearSession();
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
