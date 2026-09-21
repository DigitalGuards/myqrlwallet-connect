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
  icon: 'data:image/png;base64,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',
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
