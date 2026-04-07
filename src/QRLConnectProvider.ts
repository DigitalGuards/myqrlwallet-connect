/**
 * QRL Connect EIP-1193 Provider.
 * Bridges JSON-RPC requests from dApp to QRL Wallet via the relay.
 */

import EventEmitter from 'eventemitter3';
import { ConnectionManager } from './ConnectionManager.js';
import { REQUEST_TIMEOUT_MS, RESTRICTED_METHODS, UNRESTRICTED_METHODS } from './config.js';
import { log, warn } from './utils/logger.js';
import { isMobileBrowser, getAppStoreUrl } from './utils/platform.js';
import { setDebug } from './utils/logger.js';
import {
  type JsonRpcResponse,
  type PendingRequest,
  type ProviderEvents,
  type QRLConnectOptions,
  ConnectionStatus,
} from './types.js';

let requestCounter = 0;

export class QRLConnectProvider extends EventEmitter<ProviderEvents> {
  private connectionManager: ConnectionManager;
  private pendingRequests = new Map<string | number, PendingRequest>();
  private options: QRLConnectOptions;
  readonly isQRLConnect = true;

  constructor(options: QRLConnectOptions) {
    super();
    this.options = options;

    if (options.debug) {
      setDebug(true);
    }

    this.connectionManager = new ConnectionManager({
      dappMetadata: options.dappMetadata,
      relayUrl: options.relayUrl,
      chainId: options.chainId,
      storageKey: options.storageKey,
    });

    this.setupConnectionListeners();

    // Auto-reconnect to existing session
    if (options.autoReconnect !== false) {
      this.connectionManager.reconnect();
    }
  }

  private setupConnectionListeners(): void {
    this.connectionManager.on('status_changed', (status) => {
      log('Provider', `Connection status: ${status}`);
      this.emit('statusChanged', status);

      if (status === ConnectionStatus.CONNECTED) {
        this.emit('connect', { chainId: this.connectionManager.getChainId() });
      }

      if (status === ConnectionStatus.DISCONNECTED) {
        this.emit('disconnect', {
          code: 4900,
          message: 'Disconnected from QRL Wallet',
        });
      }
    });

    this.connectionManager.on('accounts_changed', (accounts) => {
      this.emit('accountsChanged', accounts);
    });

    this.connectionManager.on('chain_changed', (chainId) => {
      this.emit('chainChanged', chainId);
    });

    this.connectionManager.on('jsonrpc_response', (response: JsonRpcResponse) => {
      const pending = this.pendingRequests.get(response.id);
      if (!pending) {
        warn('Provider', `No pending request for id ${response.id}`);
        return;
      }

      this.pendingRequests.delete(response.id);

      if (response.error) {
        pending.reject(new Error(response.error.message || 'Request failed'));
      } else {
        pending.resolve(response.result);
      }
    });

    this.connectionManager.on('wallet_info', (info) => {
      // Resolve pending qrl_requestAccounts or qrl_accounts if any
      for (const [id, pending] of this.pendingRequests) {
        if (pending.method === 'qrl_requestAccounts' || pending.method === 'qrl_accounts') {
          pending.resolve(info.accounts);
          this.pendingRequests.delete(id);
        }
      }
    });

    this.connectionManager.on('error', (err) => {
      warn('Provider', `ConnectionManager error: ${err.message}`);
      this.emit('message', { type: 'error', data: err.message });
    });

    this.connectionManager.on('connection_lost', () => {
      // Reject all pending requests
      for (const [, pending] of this.pendingRequests) {
        pending.reject(new Error('Connection to QRL Wallet lost'));
      }
      this.pendingRequests.clear();
    });
  }

  /**
   * Generate a connection URI for QR code display or deep link redirect.
   */
  async getConnectionURI(): Promise<string> {
    return this.connectionManager.getConnectionURI();
  }

  /**
   * Check if the current browser is mobile.
   */
  isMobile(): boolean {
    return isMobileBrowser();
  }

  /**
   * Get the app store URL for the QRL Wallet app.
   */
  getAppStoreUrl(): string {
    return getAppStoreUrl();
  }

  /**
   * EIP-1193 request method.
   */
  async request(args: { method: string; params?: unknown[] }): Promise<unknown> {
    const { method, params } = args;

    // Handle some methods locally
    if (method === 'qrl_chainId') {
      return this.connectionManager.getChainId();
    }

    if (method === 'qrl_accounts') {
      const accounts = this.connectionManager.getAccounts();
      if (accounts.length > 0) return accounts;
      // Fall through to request from wallet if no cached accounts
    }

    // Validate method is known
    if (!RESTRICTED_METHODS.has(method) && !UNRESTRICTED_METHODS.has(method)) {
      throw new Error(`Unsupported method: ${method}`);
    }

    // Must be connected for all remote methods
    if (this.connectionManager.getStatus() !== ConnectionStatus.CONNECTED) {
      throw new Error('Not connected to QRL Wallet');
    }

    const id = ++requestCounter;

    return new Promise((resolve, reject) => {
      const pending: PendingRequest = {
        id,
        method,
        params,
        resolve,
        reject,
        timestamp: Date.now(),
      };

      this.pendingRequests.set(id, pending);

      // Timeout for request
      const timeout = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request timeout: ${method} (${REQUEST_TIMEOUT_MS}ms)`));
        }
      }, REQUEST_TIMEOUT_MS);

      // Wrap resolve/reject to clear timeout
      const originalResolve = pending.resolve;
      const originalReject = pending.reject;
      pending.resolve = (result) => {
        clearTimeout(timeout);
        originalResolve(result);
      };
      pending.reject = (error) => {
        clearTimeout(timeout);
        originalReject(error);
      };

      // Send to wallet
      this.connectionManager.sendJsonRpc({
        jsonrpc: '2.0',
        id,
        method,
        params,
      });
    });
  }

  /**
   * Get the current connection status.
   */
  getStatus(): ConnectionStatus {
    return this.connectionManager.getStatus();
  }

  /**
   * Get connected accounts.
   */
  getAccounts(): string[] {
    return this.connectionManager.getAccounts();
  }

  /**
   * Get the channel ID for this connection.
   */
  getChannelId(): string {
    return this.connectionManager.getChannelId();
  }

  /**
   * Check if connected and keys exchanged.
   */
  isConnected(): boolean {
    return this.connectionManager.getStatus() === ConnectionStatus.CONNECTED;
  }

  /**
   * Check if a stored session exists that can be reconnected.
   */
  hasStoredSession(): boolean {
    return this.connectionManager.hasStoredSession();
  }

  /**
   * Reset the connection and start a fresh pairing with a new channel.
   * Use this when the user wants to create a new connection instead of
   * reconnecting to an existing session.
   */
  async newConnection(): Promise<string> {
    // Reject pending requests
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error('Connection reset'));
    }
    this.pendingRequests.clear();

    this.connectionManager.resetForNewChannel();
    return this.getConnectionURI();
  }

  /**
   * Disconnect from wallet and clean up.
   */
  disconnect(): void {
    // Reject all pending requests
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error('Disconnected'));
    }
    this.pendingRequests.clear();
    this.connectionManager.disconnect();
  }
}
