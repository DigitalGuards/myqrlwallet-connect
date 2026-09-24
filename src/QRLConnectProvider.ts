/**
 * QRL Connect EIP-1193 Provider.
 * Bridges JSON-RPC requests from dApp to QRL Wallet via the relay.
 */

import EventEmitter from 'eventemitter3';
import { ConnectionManager } from './ConnectionManager.js';
import { getBrowserStorage } from './SessionOwnership.js';
import {
  classifyRpcMethod,
  isCurrentQrlAddress,
  isValidJsonRpcId,
  isValidJsonRpcMethod,
  REQUEST_TIMEOUT_MS,
  STORAGE_KEY_PREFIX,
} from './config.js';
import { TYPED_DATA_LIMITS } from './signing/typedData.js';
import { log, warn } from './utils/logger.js';
import { isMobileBrowser, getAppStoreUrl, attemptWalletRedirect } from './utils/platform.js';
import { setDebug } from './utils/logger.js';
import { randomUuid } from './crypto/primitives.js';
import {
  type JsonRpcResponse,
  type PendingRequest,
  type ProviderEvents,
  type QRLConnectOptions,
  ConnectionStatus,
} from './types.js';

/**
 * Default EIP-6963 identity for the QRL Connect provider. The `rdns` is
 * deliberately distinct from the QRL browser extension (`theqrl.org`) so
 * both wallets can coexist in the same dApp picker.
 */
export const QRL_CONNECT_PROVIDER_INFO = {
  name: 'MyQRLWallet',
  rdns: 'com.qrlwallet.connect',
  icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByeD0iMTQuMyIgZmlsbD0iIzMzQURFNiIvPjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDE0IDE0KSBzY2FsZSgxLjUpIj48cmVjdCB4PSI1LjEiIHk9Ii40IiB3aWR0aD0iNC40IiBoZWlnaHQ9IjQuNCIgcng9Ii41IiBmaWxsPSIjMDQxNzI1Ii8+PHJlY3QgeD0iOS44IiB5PSIuNCIgd2lkdGg9IjQuNCIgaGVpZ2h0PSI0LjQiIHJ4PSIuNSIgZmlsbD0iIzA0MTcyNSIvPjxyZWN0IHg9IjE0LjUiIHk9Ii40IiB3aWR0aD0iNC40IiBoZWlnaHQ9IjQuNCIgcng9Ii41IiBmaWxsPSIjMDQxNzI1Ii8+PHJlY3QgeD0iLjQiIHk9IjUuMSIgd2lkdGg9IjQuNCIgaGVpZ2h0PSI0LjQiIHJ4PSIuNSIgZmlsbD0iIzA0MTcyNSIvPjxyZWN0IHg9IjE5LjIiIHk9IjUuMSIgd2lkdGg9IjQuNCIgaGVpZ2h0PSI0LjQiIHJ4PSIuNSIgZmlsbD0iIzA0MTcyNSIvPjxyZWN0IHg9Ii40IiB5PSI5LjgiIHdpZHRoPSI0LjQiIGhlaWdodD0iNC40IiByeD0iLjUiIGZpbGw9IiMwNDE3MjUiLz48cmVjdCB4PSIxOS4yIiB5PSI5LjgiIHdpZHRoPSI0LjQiIGhlaWdodD0iNC40IiByeD0iLjUiIGZpbGw9IiMwNDE3MjUiLz48cmVjdCB4PSI1LjEiIHk9IjE0LjUiIHdpZHRoPSI0LjQiIGhlaWdodD0iNC40IiByeD0iLjUiIGZpbGw9IiMwNDE3MjUiLz48cmVjdCB4PSIxNC41IiB5PSIxNC41IiB3aWR0aD0iNC40IiBoZWlnaHQ9IjQuNCIgcng9Ii41IiBmaWxsPSIjMDQxNzI1Ii8+PHJlY3QgeD0iLjQiIHk9IjE5LjIiIHdpZHRoPSI0LjQiIGhlaWdodD0iNC40IiByeD0iLjUiIGZpbGw9IiMwNDE3MjUiLz48cmVjdCB4PSI1LjEiIHk9IjE5LjIiIHdpZHRoPSI0LjQiIGhlaWdodD0iNC40IiByeD0iLjUiIGZpbGw9IiMwNDE3MjUiLz48cmVjdCB4PSIxNC41IiB5PSIxOS4yIiB3aWR0aD0iNC40IiBoZWlnaHQ9IjQuNCIgcng9Ii41IiBmaWxsPSIjMDQxNzI1Ii8+PHJlY3QgeD0iMTkuMiIgeT0iMTkuMiIgd2lkdGg9IjQuNCIgaGVpZ2h0PSI0LjQiIHJ4PSIuNSIgZmlsbD0iIzA0MTcyNSIvPjwvZz48L3N2Zz4=',
} as const;

const EIP6963_ANNOUNCE_EVENT = 'eip6963:announceProvider';
const EIP6963_REQUEST_EVENT = 'eip6963:requestProvider';

/** Persisted record of a restricted request awaiting a wallet response. */
interface InflightRecord {
  id: string | number;
  method: string;
  ts: number;
  expectedChainId?: string | undefined;
}

interface QueuedRestrictedRequest {
  method: string;
  params?: unknown[] | undefined;
  expectedChainId?: string | undefined;
  generation: number;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

function isRecordObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isUnknownArray(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

function parseInflightRecord(v: unknown): InflightRecord | null {
  if (!isRecordObj(v)) return null;
  const { id, method, ts } = v;
  if (!isValidJsonRpcId(id) || !isValidJsonRpcMethod(method)) return null;
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null;
  if (v.expectedChainId !== undefined && typeof v.expectedChainId !== 'string') return null;
  return { id, method, ts, expectedChainId: v.expectedChainId };
}

function canonicalChainId(value: unknown): string {
  if (typeof value !== 'string' || value.length > 66 || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error('wallet_switchQrlChain requires a 0x-prefixed chainId');
  }
  return `0x${BigInt(value).toString(16)}`;
}

function requestedSwitchChainId(params: unknown[] | undefined): string {
  if (params?.length !== 1) {
    throw new Error('wallet_switchQrlChain requires one chain configuration object');
  }
  const request = params?.[0];
  if (!isRecordObj(request)) {
    throw new Error('wallet_switchQrlChain requires one chain configuration object');
  }
  return canonicalChainId(request.chainId);
}

const TRANSACTION_FIELDS = new Set(['from', 'to', 'value', 'gas', 'data', 'chainId']);
const QRL_TRANSACTION_MAX_DATA_BYTES = 128 * 1024;
const QRL_TRANSACTION_MAX_QUANTITY_HEX_DIGITS = 64;
const RPC_QUANTITY_RE = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;

function validateRpcQuantity(value: unknown, field: 'value' | 'gas' | 'chainId'): void {
  if (field === 'gas' && typeof value === 'number') {
    if (Number.isSafeInteger(value) && value >= 0) return;
    throw new Error('transaction gas must be a non-negative safe integer');
  }
  if (
    typeof value !== 'string' ||
    value.length > QRL_TRANSACTION_MAX_QUANTITY_HEX_DIGITS + 2 ||
    !RPC_QUANTITY_RE.test(value)
  ) {
    throw new Error(`transaction ${field} must be a canonical 0x quantity`);
  }
  if (field === 'gas' && BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('transaction gas exceeds the wallet safe-integer limit');
  }
  if (field === 'chainId' && BigInt(value) === 0n) {
    throw new Error('transaction chainId must be positive');
  }
}

function validateTransactionRequest(
  method: string,
  params: unknown[] | undefined,
  authorizedAccount: string,
  currentChainId: string
): void {
  if (params?.length !== 1 || !isRecordObj(params[0])) {
    throw new Error(`${method} requires exactly one transaction object`);
  }
  const tx = params[0];
  const unsupported = Object.keys(tx).find((field) => !TRANSACTION_FIELDS.has(field));
  if (unsupported) throw new Error(`transaction field is not supported: ${unsupported}`);
  if (!isCurrentQrlAddress(tx.from)) {
    throw new Error('transaction from must be a valid Q-address');
  }
  if (tx.from !== authorizedAccount) {
    throw new Error('transaction from is not the authorized account');
  }
  if (!isCurrentQrlAddress(tx.to)) {
    throw new Error('transaction to must be a valid Q-address');
  }
  if ('value' in tx) validateRpcQuantity(tx.value, 'value');
  if ('gas' in tx) validateRpcQuantity(tx.gas, 'gas');
  if ('chainId' in tx) {
    validateRpcQuantity(tx.chainId, 'chainId');
    if (canonicalChainId(tx.chainId) !== canonicalChainId(currentChainId)) {
      throw new Error('transaction chainId does not match the connected wallet');
    }
  }
  if (
    'data' in tx &&
    (typeof tx.data !== 'string' ||
      tx.data.length > QRL_TRANSACTION_MAX_DATA_BYTES * 2 + 2 ||
      !/^0x(?:[0-9a-fA-F]{2})*$/.test(tx.data))
  ) {
    throw new Error('transaction data must be bounded 0x-prefixed bytes');
  }
}

/**
 * Capture JSON-RPC params at the request boundary. Requests may wait for a
 * channel rejoin or another approval, and retaining caller-owned objects would
 * let later mutation change the payload after validation or after request().
 */
function snapshotRequestParams(params: unknown[] | undefined): unknown[] | undefined {
  if (params === undefined) return undefined;
  try {
    const encoded = JSON.stringify(params);
    if (typeof encoded !== 'string') throw new Error('params did not serialize');
    const snapshot: unknown = JSON.parse(encoded);
    if (!isUnknownArray(snapshot)) throw new Error('params must serialize to an array');
    return snapshot;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Request params must be JSON-serializable: ${detail}`);
  }
}

function validateRestrictedRequest(
  method: string,
  params: unknown[] | undefined,
  authorizedAccounts: string[],
  currentChainId: string
): string | undefined {
  if (method === 'qrl_requestAccounts') {
    if (params !== undefined && params.length !== 0) {
      throw new Error('qrl_requestAccounts does not accept parameters');
    }
    return undefined;
  }
  if (method === 'wallet_switchQrlChain') {
    return requestedSwitchChainId(params);
  }
  const authorizedAccount = authorizedAccounts[0];
  if (!authorizedAccount || authorizedAccounts.length !== 1) {
    throw new Error('No authorized account: call qrl_requestAccounts first');
  }
  if (method === 'qrl_sendTransaction' || method === 'qrl_signTransaction') {
    validateTransactionRequest(method, params, authorizedAccount, currentChainId);
    return undefined;
  }
  if (method === 'qrl_signMessage') {
    if (params?.length !== 2) {
      throw new Error('qrl_signMessage requires [signer, messageHex]');
    }
    const [signer, messageHex] = params;
    if (!isCurrentQrlAddress(signer)) {
      throw new Error('qrl_signMessage requires a valid Q-address signer');
    }
    if (signer !== authorizedAccount) {
      throw new Error('qrl_signMessage signer is not the authorized account');
    }
    if (
      typeof messageHex !== 'string' ||
      messageHex.length > TYPED_DATA_LIMITS.maxDynamicBytes * 2 + 2 ||
      !/^0x([0-9a-fA-F]{2})*$/.test(messageHex)
    ) {
      throw new Error('qrl_signMessage requires bounded 0x-prefixed bytes');
    }
    return undefined;
  }
  if (method !== 'qrl_signTypedData') return undefined;
  if (params?.length !== 2) {
    throw new Error('qrl_signTypedData requires [signer, payload]');
  }
  if (!isCurrentQrlAddress(params[0])) {
    throw new Error('qrl_signTypedData requires a valid Q-address signer');
  }
  if (params[0] !== authorizedAccount) {
    throw new Error('qrl_signTypedData signer is not the authorized account');
  }
  throw new Error(
    'qrl_signTypedData is unavailable for QIP-55 until the 64-byte word encoding and signing scheme version are finalized'
  );
}

function requiresAuthorizedAccount(method: string): boolean {
  return (
    method === 'qrl_sendTransaction' ||
    method === 'qrl_signTransaction' ||
    method === 'qrl_signMessage' ||
    method === 'qrl_signTypedData'
  );
}

export class QRLConnectProvider extends EventEmitter<ProviderEvents> {
  private connectionManager: ConnectionManager;
  private pendingRequests = new Map<string | number, PendingRequest>();
  private options: QRLConnectOptions;
  private eip6963Detail: Readonly<{
    info: Readonly<{ uuid: string; name: string; icon: string; rdns: string }>;
    provider: QRLConnectProvider;
  }> | null = null;
  private eip6963RequestListener: (() => void) | null = null;
  private resumeListener: (() => void) | null = null;
  private resumeDebounce: ReturnType<typeof setTimeout> | null = null;
  // In-flight restricted requests persisted across page loads. A same-device
  // approval bounces the user back via a URL open, which RELOADS the dApp
  // page: the fresh context has no pendingRequests entry, so the response
  // (relay-buffered or live) would be silently dropped. Orphans from the
  // previous page are re-emitted as 'late_response' events instead.
  private inflightKey: string;
  private orphanedRequests = new Map<
    string | number,
    { method: string; expectedChainId?: string | undefined }
  >();
  // Random per-instance prefix keeps request ids unique across page loads.
  // A bare counter restarts at 1 on reload, and the relay buffers messages
  // for 5 minutes, so a stale buffered response could otherwise be matched
  // to a fresh request that drew the same small id.
  private readonly requestIdPrefix = randomUuid().slice(0, 8);
  private requestCounter = 0;
  // Cancels work that is still awaiting channel restoration and therefore has
  // no pendingRequests entry yet. Without this barrier, disconnect() or
  // newConnection() could miss that request and let it cross into a later
  // channel once the stale ensureChannelJoined() promise settled.
  private requestGeneration = 0;
  private requestCancellationMessage = 'Connection changed while request was pending';
  private lifecycleTransition: 'reset' | 'disconnect' | null = null;
  private disconnectInFlight: Promise<void> | null = null;
  private restrictedRequestActive = false;
  private restrictedRequestQueue: QueuedRestrictedRequest[] = [];
  readonly isQRLConnect = true;

  constructor(options: QRLConnectOptions) {
    super();
    this.options = options;
    this.inflightKey = `${options.storageKey ?? `${STORAGE_KEY_PREFIX}:session`}:inflight`;
    for (const rec of this.readInflight()) {
      this.orphanedRequests.set(rec.id, {
        method: rec.method,
        expectedChainId: rec.expectedChainId,
      });
    }

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
      void this.connectionManager.reconnect();
    }

    // Recover the relay socket when the dApp tab returns to the foreground
    // (its JS is throttled/frozen while backgrounded on the same device, so
    // socket.io's own retry can lag). Independent of any native bridge.
    this.setupResumeListeners();

    // EIP-6963 announce so dApp pickers see this provider next to the
    // QRL browser extension. Default-on in browsers; opt-out via
    // `announceProvider: false`.
    if (options.announceProvider !== false) {
      this.startEip6963Announce();
    }
  }

  private startEip6963Announce(): void {
    if (typeof window === 'undefined' || typeof CustomEvent === 'undefined') {
      return;
    }

    const overrides = this.options.providerInfo ?? {};
    this.eip6963Detail = Object.freeze({
      info: Object.freeze({
        uuid: randomUuid(),
        name: overrides.name ?? QRL_CONNECT_PROVIDER_INFO.name,
        icon: overrides.icon ?? QRL_CONNECT_PROVIDER_INFO.icon,
        rdns: overrides.rdns ?? QRL_CONNECT_PROVIDER_INFO.rdns,
      }),
      provider: this,
    });

    const announce = () => {
      if (!this.eip6963Detail) return;
      window.dispatchEvent(new CustomEvent(EIP6963_ANNOUNCE_EVENT, { detail: this.eip6963Detail }));
    };

    // Spec requires re-announce every time a dApp dispatches `requestProvider`,
    // not just once at construction (pickers fire it on mount, after our
    // initial announce has already gone past).
    this.eip6963RequestListener = announce;
    window.addEventListener(EIP6963_REQUEST_EVENT, announce);
    announce();
  }

  /**
   * Re-open the relay socket when the dApp tab regains focus or the network
   * comes back. Debounced because visibilitychange + online can fire together.
   * No-op when already connected (ConnectionManager.resume guards that).
   */
  private setupResumeListeners(): void {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    if (this.resumeListener) return; // already armed (idempotent re-arm)

    const resume = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (this.resumeDebounce) clearTimeout(this.resumeDebounce);
      this.resumeDebounce = setTimeout(() => {
        this.resumeDebounce = null;
        this.connectionManager.resume();
      }, 300);
    };

    this.resumeListener = resume;
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', resume);
    window.addEventListener('pageshow', resume);
  }

  /**
   * Remove the foreground/online resume listeners. Called on disconnect so a
   * torn-down session can't be silently revived by a later tab focus; the
   * listeners are re-armed by getConnectionURI()/newConnection() if the same
   * provider is re-paired. Safe in any env.
   */
  private teardownResumeListeners(): void {
    if (typeof window !== 'undefined' && typeof document !== 'undefined' && this.resumeListener) {
      document.removeEventListener('visibilitychange', this.resumeListener);
      window.removeEventListener('online', this.resumeListener);
      window.removeEventListener('pageshow', this.resumeListener);
    }
    this.resumeListener = null;
    if (this.resumeDebounce) {
      clearTimeout(this.resumeDebounce);
      this.resumeDebounce = null;
    }
  }

  /**
   * Stop announcing this provider over EIP-6963. Safe to call from any env.
   */
  stopEip6963Announce(): void {
    if (typeof window !== 'undefined' && this.eip6963RequestListener) {
      window.removeEventListener(EIP6963_REQUEST_EVENT, this.eip6963RequestListener);
    }
    this.eip6963RequestListener = null;
    this.eip6963Detail = null;
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
      void this.handleJsonRpcResponse(response);
    });

    this.connectionManager.on('error', (err) => {
      warn('Provider', `ConnectionManager error: ${err.message}`);
      this.emit('message', { type: 'error', data: err.message });
    });

    this.connectionManager.on('connection_lost', () => {
      this.cancelAllRequests(new Error('Connection to QRL Wallet lost'));
    });

    this.connectionManager.on('session_terminated', () => {
      // The wallet terminated the pairing (or a tombstone was observed on
      // join): buffered/in-flight requests can never be answered. Fail them
      // now rather than letting callers run out the 5-minute timeout.
      this.cancelAllRequests(new Error('Session terminated by wallet'));
      this.clearAllInflight();
    });
  }

  private async handleJsonRpcResponse(response: JsonRpcResponse): Promise<void> {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      const orphan = this.orphanedRequests.get(response.id);
      if (!orphan) {
        warn('Provider', `No pending request for id ${response.id}`);
        return;
      }

      // Completed after the page reloaded (same-device return redirect): the
      // original await is gone, so surface it as an event after applying any
      // security-sensitive postcondition to the restored session.
      this.settleInflight(response.id);
      if (!response.error && orphan.method === 'qrl_requestAccounts') {
        try {
          const accounts = await this.connectionManager.authorizeAccounts(response.result);
          this.emit('late_response', { id: response.id, method: orphan.method, result: accounts });
        } catch (error) {
          this.emit('late_response', {
            id: response.id,
            method: orphan.method,
            error: {
              code: -32000,
              message: error instanceof Error ? error.message : 'Invalid account approval response',
            },
          });
        }
        return;
      }
      if (
        !response.error &&
        orphan.method === 'wallet_switchQrlChain' &&
        (!orphan.expectedChainId || !this.isCurrentChain(orphan.expectedChainId))
      ) {
        this.emit('late_response', {
          id: response.id,
          method: orphan.method,
          error: {
            code: -32000,
            message: `Wallet reported success but did not switch to requested chain ${orphan.expectedChainId ?? '(unknown)'}`,
          },
        });
        return;
      }
      this.emit('late_response', {
        id: response.id,
        method: orphan.method,
        ...(response.error ? { error: response.error } : { result: response.result }),
      });
      return;
    }

    this.pendingRequests.delete(response.id);
    if (response.error) {
      pending.reject(
        Object.assign(new Error(response.error.message || 'Request failed'), {
          code: response.error.code,
          ...(response.error.data === undefined ? {} : { data: response.error.data }),
        })
      );
      return;
    }
    try {
      if (pending.method === 'qrl_requestAccounts') {
        const accounts = await this.connectionManager.authorizeAccounts(response.result);
        pending.resolve(accounts);
        return;
      }
      if (pending.method === 'wallet_switchQrlChain') {
        const requested = pending.expectedChainId;
        if (!requested) {
          throw new Error('Missing wallet_switchQrlChain postcondition');
        }
        if (!this.isCurrentChain(requested)) {
          throw new Error(
            `Wallet reported success but did not switch to requested chain ${requested}`
          );
        }
      }
      pending.resolve(response.result);
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private cancelAllRequests(error: Error): void {
    this.requestGeneration++;
    this.requestCancellationMessage = error.message;
    for (const [, pending] of this.pendingRequests) pending.reject(error);
    this.pendingRequests.clear();
    for (const queued of this.restrictedRequestQueue) queued.reject(error);
    this.restrictedRequestQueue = [];
  }

  private assertRequestGeneration(generation: number): void {
    if (generation !== this.requestGeneration) {
      throw new Error(this.requestCancellationMessage);
    }
  }

  private isCurrentChain(expected: string): boolean {
    try {
      return canonicalChainId(this.connectionManager.getChainId()) === expected;
    } catch {
      return false;
    }
  }

  /**
   * Generate a connection URI for QR code display or deep link redirect.
   */
  async getConnectionURI(): Promise<string> {
    if (this.lifecycleTransition) {
      throw new Error('Connection lifecycle transition is already in progress');
    }
    // ConnectionManager rotates the channel and key exchange for every fresh
    // URI, so this public entry point is a lifecycle transition even when the
    // caller does not use newConnection(). Retire provider-level requests too:
    // otherwise a queued approval from the prior wallet could be sent after
    // the new wallet pairs.
    this.lifecycleTransition = 'reset';
    this.cancelAllRequests(new Error('Connection reset'));
    this.clearAllInflight();

    try {
      // Re-arm the foreground-resume listeners in case a prior disconnect tore
      // them down and the dApp is re-pairing on this same provider instance.
      this.setupResumeListeners();
      return await this.connectionManager.getConnectionURI();
    } finally {
      this.lifecycleTransition = null;
    }
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
    if (!isValidJsonRpcMethod(method)) {
      throw new Error('Invalid JSON-RPC method');
    }
    if (this.lifecycleTransition) {
      throw new Error(this.requestCancellationMessage);
    }

    // Handle some methods locally
    if (method === 'qrl_chainId') {
      return this.connectionManager.getChainId();
    }

    if (method === 'qrl_accounts') {
      // This is the local authorization cache, not a prompt and not a node RPC.
      // Before qrl_requestAccounts approval it must remain an empty array.
      return this.connectionManager.getAccounts();
    }

    const policy = classifyRpcMethod(method);
    if (policy === 'unsupported') {
      throw new Error(`Unsupported method: ${method}`);
    }

    const stableParams = snapshotRequestParams(params);
    const generation = this.requestGeneration;

    if (policy === 'restricted') {
      if (requiresAuthorizedAccount(method) && this.connectionManager.getAccounts().length === 0) {
        throw new Error('No authorized account: call qrl_requestAccounts first');
      }
      const expectedChainId = validateRestrictedRequest(
        method,
        stableParams,
        this.connectionManager.getAccounts(),
        this.connectionManager.getChainId()
      );
      return this.enqueueRestrictedRequest(method, stableParams, expectedChainId, generation);
    }

    return this.performRequest(method, stableParams, false, undefined, generation);
  }

  /**
   * Keep at most one approval-bound request active. Wallet approval screens
   * are a serial human interaction, and request-id ordering must remain
   * stable even when a dApp fires several signing calls concurrently.
   */
  private enqueueRestrictedRequest(
    method: string,
    params: unknown[] | undefined,
    expectedChainId: string | undefined,
    generation: number
  ): Promise<unknown> {
    if (!this.restrictedRequestActive) {
      this.restrictedRequestActive = true;
      return this.runRestrictedRequest(method, params, expectedChainId, generation);
    }
    return new Promise((resolve, reject) => {
      this.restrictedRequestQueue.push({
        method,
        params,
        expectedChainId,
        generation,
        resolve,
        reject,
      });
    });
  }

  private runRestrictedRequest(
    method: string,
    params: unknown[] | undefined,
    expectedChainId: string | undefined,
    generation: number
  ): Promise<unknown> {
    const task = this.performRequest(method, params, true, expectedChainId, generation);
    void task.then(
      () => {
        this.finishRestrictedRequest();
      },
      () => {
        this.finishRestrictedRequest();
      }
    );
    return task;
  }

  private finishRestrictedRequest(): void {
    const next = this.restrictedRequestQueue.shift();
    if (!next) {
      this.restrictedRequestActive = false;
      return;
    }
    const task = this.runRestrictedRequest(
      next.method,
      next.params,
      next.expectedChainId,
      next.generation
    );
    void task.then(next.resolve, next.reject);
  }

  private async performRequest(
    method: string,
    params: unknown[] | undefined,
    restricted: boolean,
    expectedChainId: string | undefined,
    generation: number
  ): Promise<unknown> {
    this.assertRequestGeneration(generation);
    // A paired session survives the wallet app being backgrounded or closed:
    // its socket dies within seconds, but the relay buffers channel traffic
    // for it and the wallet re-joins on foreground. So "not CONNECTED" is not
    // a hard error while a session can be revived - it is the normal steady
    // state of a same-device mobile flow, where at most one of the two apps
    // is ever foregrounded.
    if (this.connectionManager.getStatus() !== ConnectionStatus.CONNECTED) {
      // An already-authorized account read must not round-trip through a
      // wallet that cannot answer until the user switches apps.
      if (
        method === 'qrl_requestAccounts' &&
        this.connectionManager.isPaired() &&
        this.connectionManager.getAccounts().length > 0
      ) {
        return this.connectionManager.getAccounts();
      }
      const joined = await this.connectionManager.ensureChannelJoined();
      this.assertRequestGeneration(generation);
      if (!joined) {
        throw new Error('Not connected to QRL Wallet');
      }
    }

    // A queued approval or channel rejoin can observe a different authorized
    // account or chain. Revalidate the immutable snapshot before transport.
    if (restricted) {
      validateRestrictedRequest(
        method,
        params,
        this.connectionManager.getAccounts(),
        this.connectionManager.getChainId()
      );
    }

    if (this.requestCounter >= Number.MAX_SAFE_INTEGER) {
      throw new Error('JSON-RPC request id counter exhausted');
    }
    const id = `${this.requestIdPrefix}-${++this.requestCounter}`;

    return new Promise((resolve, reject) => {
      const pending: PendingRequest = {
        id,
        method,
        params,
        expectedChainId,
        resolve,
        reject,
        timestamp: Date.now(),
      };

      this.pendingRequests.set(id, pending);

      // Timeout for request
      const timeout = setTimeout(() => {
        const timedOut = this.pendingRequests.get(id);
        if (!timedOut) return;
        this.pendingRequests.delete(id);
        timedOut.reject(new Error(`Request timeout: ${method} (${REQUEST_TIMEOUT_MS}ms)`));
      }, REQUEST_TIMEOUT_MS);

      // Wrap resolve/reject to clear timeout + the persisted in-flight record
      const originalResolve = pending.resolve;
      const originalReject = pending.reject;
      pending.resolve = (result) => {
        clearTimeout(timeout);
        this.settleInflight(id);
        originalResolve(result);
      };
      pending.reject = (error) => {
        clearTimeout(timeout);
        this.settleInflight(id);
        originalReject(error);
      };

      // Persist approval-bound requests so a same-device return redirect
      // (which reloads this page) cannot orphan the wallet's answer.
      if (restricted) {
        this.persistInflight(id, method, expectedChainId);
      }

      // Send to wallet
      let sent: Promise<void>;
      try {
        sent = this.connectionManager.sendJsonRpc({
          jsonrpc: '2.0',
          id,
          method,
          params,
        });
      } catch (err) {
        this.pendingRequests.delete(id);
        pending.reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      // If the send never reaches the relay, fail fast instead of holding
      // the caller for the full request timeout.
      sent.catch((err: unknown) => {
        const failed = this.pendingRequests.get(id);
        if (!failed) return;
        this.pendingRequests.delete(id);
        failed.reject(err instanceof Error ? err : new Error(String(err)));
      });

      // Same-device wake: the wallet app cannot be foregrounded while the
      // user is here in the browser, so an approval-needing call would
      // otherwise sit in the relay buffer until they switch apps on their
      // own. Navigate only after the relay acked the ciphertext -
      // redirecting first races iOS freezing this page's JS mid-send.
      if (this.shouldRedirectToWallet(method)) {
        void sent.then(
          () => attemptWalletRedirect(this.walletWakeUri()),
          () => undefined
        );
      }
    });
  }

  /**
   * Redirect only for calls the user must approve, on mobile, and only when
   * the wallet is actually absent from the channel: right after pairing its
   * socket lingers and a pointless app flash would be jarring.
   *
   * qrl_requestAccounts is excluded even though it is restricted: dApps call
   * it on page load to restore a session, so it can run with no user gesture
   * (an unsolicited "Open in MyQRLWallet?" sheet on load) and pairing UIs
   * already own their own deep-link step.
   */
  private shouldRedirectToWallet(method: string): boolean {
    return (
      this.options.walletRedirectOnRequest !== false &&
      classifyRpcMethod(method) === 'restricted' &&
      method !== 'qrl_requestAccounts' &&
      isMobileBrowser() &&
      !this.connectionManager.isWalletPresent()
    );
  }

  // ── In-flight persistence (survive the return-redirect reload) ──────

  private readInflight(): InflightRecord[] {
    const storage = getBrowserStorage();
    if (!storage) return [];
    try {
      const raw = storage.getItem(this.inflightKey);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const now = Date.now();
      const records: InflightRecord[] = [];
      for (const v of parsed) {
        const rec = parseInflightRecord(v);
        // Expire with the request timeout: past it the wallet's answer would
        // have been rejected on the original page too.
        if (rec && now - rec.ts <= REQUEST_TIMEOUT_MS) records.push(rec);
      }
      return records;
    } catch {
      return [];
    }
  }

  private writeInflight(records: InflightRecord[]): void {
    const storage = getBrowserStorage();
    if (!storage) return;
    try {
      if (records.length === 0) {
        storage.removeItem(this.inflightKey);
      } else {
        storage.setItem(this.inflightKey, JSON.stringify(records));
      }
    } catch {
      // Best effort: without storage the reload just loses the response,
      // which is the pre-existing behavior.
    }
  }

  private persistInflight(id: string | number, method: string, expectedChainId?: string): void {
    const records = this.readInflight().filter((r) => r.id !== id);
    records.push({ id, method, ts: Date.now(), expectedChainId });
    this.writeInflight(records);
  }

  private settleInflight(id: string | number): void {
    this.orphanedRequests.delete(id);
    this.writeInflight(this.readInflight().filter((r) => r.id !== id));
  }

  private clearAllInflight(): void {
    this.orphanedRequests.clear();
    this.writeInflight([]);
  }

  /**
   * Wake URI for the wallet app. Carries no pairing payload: the app
   * foregrounds on any `qrlconnect:` URL and re-joins its sessions (draining
   * the buffered request); the cid lets a future wallet jump straight to the
   * right approval.
   *
   * MUST stay query-only (no host/path). The mobile app routes deep links
   * with expo-router, which maps anything after the scheme to an in-app
   * route: `qrlconnect://resume?...` lands on the "+not-found" screen and
   * unmounts the WebView, so the wake achieves nothing. The hostless form
   * routes to the WebView tab exactly like the pairing URIs
   * (`qrlconnect://?q=...`), which is the whole point of the wake.
   */
  private walletWakeUri(): string {
    return `qrlconnect://?wake=${encodeURIComponent(this.connectionManager.getChannelId())}`;
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
   * True while a pairing exists (keys exchanged), even when the wallet app
   * is backgrounded and its socket is out of the channel. Combine with
   * getStatus() to tell "wallet away, session intact" (paired + WAITING)
   * apart from "waiting for a first scan" in pairing UIs.
   */
  isPaired(): boolean {
    return this.connectionManager.isPaired();
  }

  /** True while the wallet is actually present in the relay channel. */
  isWalletPresent(): boolean {
    return this.connectionManager.isWalletPresent();
  }

  /**
   * Reset the connection and start a fresh pairing with a new channel.
   * Use this when the user wants to create a new connection instead of
   * reconnecting to an existing session.
   */
  async newConnection(): Promise<string> {
    if (this.lifecycleTransition) {
      throw new Error('Connection lifecycle transition is already in progress');
    }
    this.lifecycleTransition = 'reset';
    this.cancelAllRequests(new Error('Connection reset'));
    this.clearAllInflight();

    try {
      // Await so the outbound TERMINATE has time to land on the relay
      // before we rotate the socket. Wallet side sees instant disconnect.
      await this.connectionManager.resetForNewChannel();
      this.setupResumeListeners();
      return await this.connectionManager.getConnectionURI();
    } finally {
      this.lifecycleTransition = null;
    }
  }

  /**
   * Disconnect from wallet and clean up. Returns once the TERMINATE has
   * either been flushed to the relay or the 800ms best-effort window has
   * elapsed - the wallet gets an instant disconnect instead of landing in
   * its stale-session grace period.
   */
  disconnect(): Promise<void> {
    if (this.disconnectInFlight) return this.disconnectInFlight;
    if (this.lifecycleTransition) {
      return Promise.reject(new Error('Connection lifecycle transition is already in progress'));
    }
    this.lifecycleTransition = 'disconnect';
    this.cancelAllRequests(new Error('Disconnected'));
    this.clearAllInflight();
    this.teardownResumeListeners();
    const task = Promise.resolve()
      .then(() => this.connectionManager.disconnect())
      .finally(() => {
        this.lifecycleTransition = null;
        if (this.disconnectInFlight === task) this.disconnectInFlight = null;
      });
    this.disconnectInFlight = task;
    return task;
  }
}
