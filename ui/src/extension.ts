/** The EIP-1193 events used by an extension session. */
export type ExtensionSessionEvent = 'accountsChanged' | 'chainChanged' | 'disconnect';

/** Structural EIP-1193 provider received through EIP-6963 discovery. */
export interface ExtensionSessionProvider {
  request(args: { method: string; params?: readonly unknown[] }): Promise<unknown>;
  on(event: ExtensionSessionEvent, listener: (value: unknown) => void): unknown;
  removeListener(event: ExtensionSessionEvent, listener: (value: unknown) => void): unknown;
}

export type ExtensionSessionStatus =
  | 'idle'
  | 'pending'
  | 'connected'
  | 'locked'
  | 'rejected'
  | 'error'
  | 'disconnecting'
  | 'disconnected';

export interface ExtensionSessionError {
  readonly operation: 'connect' | 'restore' | ExtensionSessionEvent;
  readonly code: number | null;
  readonly message: string;
  readonly cause: unknown;
}

/** Enable account actions only while status is connected. */
export interface ExtensionSessionState {
  readonly status: ExtensionSessionStatus;
  readonly accounts: readonly string[];
  /** Last chainChanged value, or null until one arrives. */
  readonly chainId: string | null;
  /** Whether account events may restore this connection. */
  readonly intent: boolean;
  readonly error: ExtensionSessionError | null;
}

export interface ExtensionSessionHandlers {
  onStateChange?: (state: ExtensionSessionState) => void;
}

export interface ExtensionSession {
  readonly provider: ExtensionSessionProvider;
  getState(): ExtensionSessionState;
  /** Await the original approval request, including wallet unlock. */
  connect(): Promise<ExtensionSessionState>;
  /** Probe qrl_accounts and retain intent when locked or ungranted. */
  restore(): Promise<ExtensionSessionState>;
  /** Explicit user disconnect: revoke the origin's grant and clean up locally. */
  disconnect(): Promise<ExtensionSessionState>;
  /** Terminal local teardown. Never revokes permissions or calls handlers. */
  dispose(): void;
}

function sessionError(
  cause: unknown,
  operation: ExtensionSessionError['operation']
): ExtensionSessionError {
  const value = typeof cause === 'object' && cause !== null ? cause : {};
  return {
    operation,
    code: 'code' in value && typeof value.code === 'number' ? value.code : null,
    message:
      'message' in value && typeof value.message === 'string'
        ? value.message
        : typeof cause === 'string'
          ? cause
          : 'Wallet request failed',
    cause,
  };
}

function readAccounts(value: unknown): string[] {
  if (!Array.isArray(value)) throw new TypeError('Wallet returned an invalid account list');
  return Array.from(value, (account: unknown) => {
    if (typeof account !== 'string' || account.length === 0) {
      throw new TypeError('Wallet returned an invalid account list');
    }
    return account;
  });
}

/**
 * Framework-free extension lifecycle. Listeners precede every request or probe.
 * Empty accounts retain the selected provider and intent. Only disconnect()
 * revokes permissions; dispose() is local teardown. Provider errors are reported
 * in state, including disconnect errors after local cleanup.
 */
export function createExtensionSession(
  provider: ExtensionSessionProvider,
  handlers: ExtensionSessionHandlers = {}
): ExtensionSession {
  let state: ExtensionSessionState = Object.freeze({
    status: 'idle',
    accounts: Object.freeze([]),
    chainId: null,
    intent: false,
    error: null,
  });
  let generation = 0;
  let disposed = false;
  let unsubscribe: (() => void) | undefined;
  let flight:
    { operation: 'connect' | 'restore'; promise: Promise<ExtensionSessionState> } | undefined;
  let closing: Promise<ExtensionSessionState> | undefined;

  function update(patch: Partial<ExtensionSessionState>): void {
    state = Object.freeze({
      ...state,
      ...patch,
      accounts: Object.freeze([...(patch.accounts ?? state.accounts)]),
    });
    if (!disposed) handlers.onStateChange?.(state);
  }

  function retire(): void {
    generation += 1;
    flight = undefined;
    unsubscribe?.();
    unsubscribe = undefined;
  }

  function current(token: number): boolean {
    return !disposed && token === generation;
  }

  function fail(cause: unknown, operation: ExtensionSessionError['operation']): void {
    const error = sessionError(cause, operation);
    retire();
    update({
      status: operation === 'connect' && error.code === 4001 ? 'rejected' : 'error',
      accounts: [],
      chainId: null,
      intent: false,
      error,
    });
  }

  function start(operation: 'connect' | 'restore'): Promise<ExtensionSessionState> {
    if (disposed) return Promise.resolve(state);
    // A new request waits for revocation to finish, so its new grant survives.
    if (closing) return closing.then(() => start(operation));
    if (flight && (flight.operation === 'connect' || operation === 'restore'))
      return flight.promise;
    retire();
    const token = generation;
    let latestAccounts: string[] | undefined;
    let awaitingReply = true;

    function applyAccounts(accounts: readonly string[]): void {
      update({ status: accounts.length ? 'connected' : 'locked', accounts, error: null });
    }

    const accountsChanged = (value: unknown): void => {
      if (!current(token)) return;
      try {
        latestAccounts = [...readAccounts(value)];
      } catch (error) {
        fail(error, 'accountsChanged');
        return;
      }
      // Approval may emit accounts before its promise settles. Continue awaiting
      // that original request, and let the most recent event win over its reply.
      if (operation === 'connect' && awaitingReply) return;
      applyAccounts(latestAccounts);
    };
    const chainChanged = (value: unknown): void => {
      if (!current(token)) return;
      if (typeof value !== 'string' || !/^0x[\da-f]+$/iu.test(value)) {
        fail(new TypeError('Wallet returned an invalid chain id'), 'chainChanged');
        return;
      }
      update({ chainId: value });
    };
    const disconnected = (value: unknown): void => {
      if (!current(token)) return;
      retire();
      update({
        status: 'disconnected',
        accounts: [],
        chainId: null,
        intent: false,
        error: sessionError(value, 'disconnect'),
      });
    };
    unsubscribe = () => {
      provider.removeListener('accountsChanged', accountsChanged);
      provider.removeListener('chainChanged', chainChanged);
      provider.removeListener('disconnect', disconnected);
    };
    try {
      provider.on('accountsChanged', accountsChanged);
      provider.on('chainChanged', chainChanged);
      provider.on('disconnect', disconnected);
    } catch (error) {
      fail(error, operation);
      return Promise.resolve(state);
    }

    const promise = Promise.resolve().then(async () => {
      if (!current(token)) return state;
      let accounts: string[];
      try {
        accounts = readAccounts(
          await provider.request({
            method: operation === 'connect' ? 'qrl_requestAccounts' : 'qrl_accounts',
          })
        );
      } catch (error) {
        if (current(token)) fail(error, operation);
        return state;
      }
      if (!current(token)) return state;
      awaitingReply = false;
      flight = undefined;
      applyAccounts(latestAccounts ?? accounts);
      return state;
    });
    flight = { operation, promise };
    update({ status: 'pending', accounts: [], chainId: null, intent: true, error: null });
    return promise;
  }

  function disconnect(): Promise<ExtensionSessionState> {
    if (disposed) return Promise.resolve(state);
    if (closing) return closing;
    // Invalidate callbacks immediately, including events emitted by revocation.
    retire();
    const token = generation;
    const promise = Promise.resolve().then(async () => {
      let error: ExtensionSessionError | null = null;
      try {
        await provider.request({
          method: 'wallet_revokePermissions',
          params: [{ qrl_accounts: {} }],
        });
      } catch (cause) {
        const failure = sessionError(cause, 'disconnect');
        if (failure.code !== -32601) error = failure;
      }
      closing = undefined;
      if (current(token)) update({ status: 'disconnected', error });
      return state;
    });
    closing = promise;
    update({ status: 'disconnecting', accounts: [], chainId: null, intent: false, error: null });
    return promise;
  }

  return {
    provider,
    getState: () => state,
    connect: () => start('connect'),
    restore: () => start('restore'),
    disconnect,
    dispose: () => {
      disposed = true;
      retire();
      update({ status: 'disconnected', accounts: [], chainId: null, intent: false, error: null });
    },
  };
}
