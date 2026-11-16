// Counts the wallet requests that wait for the user, at the place they are
// sent. A request is open from the moment it goes to the wallet until the
// wallet answers (a hash, a signature, a rejection or an error): exactly the
// time a wallet prompt can sit unseen behind its toolbar icon or on another
// device. Reads, simulations and the wait for a receipt never count.
//
// Plain functions with no DOM and no framework. <qrl-approval-hint> shows the
// result; bindApprovalHint() in approval.ts connects the two.

/**
 * Methods a wallet answers only after the user has looked at a prompt.
 * Method names are case-sensitive, and the QRL chain methods exist in two
 * spellings: the SDK's (`wallet_switchQrlChain`) and the extension's
 * (`wallet_switchQRLChain`).
 *
 * A few of these prompt only sometimes (a connect request from an origin
 * that is connected already, a switch to the chain the wallet is on). They
 * answer at once then, well inside the hint's delay.
 */
const APPROVAL_METHODS: ReadonlySet<string> = new Set([
  // Ethereum wallets
  'eth_requestAccounts',
  'eth_sendTransaction',
  'eth_signTransaction',
  'eth_sign',
  'personal_sign',
  'eth_signTypedData',
  'eth_signTypedData_v3',
  'eth_signTypedData_v4',
  'eth_decrypt',
  'eth_getEncryptionPublicKey',
  'wallet_requestPermissions',
  'wallet_switchEthereumChain',
  'wallet_addEthereumChain',
  'wallet_watchAsset',
  'wallet_sendCalls',
  // QRL wallets
  'qrl_requestAccounts',
  'qrl_sendTransaction',
  'qrl_signTransaction',
  'qrl_signMessage',
  'qrl_signTypedData',
  'qrl_signTypedData_v4',
  'wallet_switchQrlChain',
  'wallet_switchQRLChain',
  'wallet_addQrlChain',
  'wallet_addQRLChain',
]);

/** True for a JSON-RPC method that makes a wallet prompt its user. */
export const isApprovalMethod = (method: string): boolean => APPROVAL_METHODS.has(method);

/** The open wallet requests of one wallet connection. */
export interface ApprovalRequests {
  /**
   * Runs one wallet request and counts it as open until it settles. The
   * result or the rejection of `run` passes through unchanged; a `run` that
   * throws while starting comes back as a rejection.
   */
  track<T>(run: () => Promise<T>): Promise<T>;
  /** True while at least one tracked request is open. */
  pending(): boolean;
  /**
   * Calls `listener` whenever `pending()` changes. Returns the unsubscribe
   * function. A listener that throws is ignored: it must never cost the dApp
   * the wallet's answer.
   */
  subscribe(listener: () => void): () => void;
  /**
   * Forgets every open request. Call it when the wallet connection ends
   * (disconnect, account or transport change): a request that was lost with
   * the connection never settles and would count as open for good.
   */
  reset(): void;
}

/** A counter for one wallet connection. Use one per wallet, so a hint can name the right one. */
export function createApprovalRequests(): ApprovalRequests {
  let open = 0;
  // Requests from before a reset() settle into an older generation and no
  // longer count.
  let generation = 0;
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // See subscribe(): a listener's failure is its own.
      }
    }
  };
  const change = (by: 1 | -1): void => {
    const before = open > 0;
    open += by;
    if (before !== open > 0) notify();
  };
  return {
    async track<T>(run: () => Promise<T>): Promise<T> {
      const mine = generation;
      change(1);
      try {
        return await run();
      } finally {
        if (mine === generation) change(-1);
      }
    },
    pending: () => open > 0,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset() {
      generation += 1;
      if (open === 0) return;
      open = 0;
      notify();
    },
  };
}

/** The arguments of an EIP-1193 `request`. */
export interface ApprovalRequestArguments {
  method: string;
  params?: unknown[] | object;
}

/** The part of an EIP-1193 provider that sends requests. */
export interface ApprovalRequestProvider {
  request(args: ApprovalRequestArguments): Promise<unknown>;
}

/**
 * The same provider with its prompting requests counted. Everything else
 * (events, flags, other methods) reaches the original provider unchanged, so
 * the result can go wherever the provider went: an ethers `BrowserProvider`,
 * web3.js, or the dApp's own calls.
 *
 * One difference for counted methods: a provider that throws synchronously
 * from `request` now rejects the returned promise.
 *
 * A provider whose `request` is locked (a frozen provider object) is passed
 * through as it is: it keeps working, and its prompts are not counted. Count
 * those yourself with `approvals.track(() => provider.request(args))`.
 */
export function trackedProvider<P extends ApprovalRequestProvider>(
  provider: P,
  approvals: ApprovalRequests
): P {
  const request = (args: ApprovalRequestArguments): Promise<unknown> =>
    isApprovalMethod(args.method)
      ? approvals.track(() => provider.request(args))
      : provider.request(args);
  // One wrapper per method, so `tracked.on === tracked.on`.
  const bound = new Map<PropertyKey, (...args: unknown[]) => unknown>();
  return new Proxy(provider, {
    get(target, property) {
      // A property the provider has locked (frozen providers, or one defined
      // as not writable and not configurable) has to come back as it is: a
      // proxy may not report another value for it. Such a provider works
      // unchanged; when the locked property is `request`, its prompts are
      // not counted.
      const own = Reflect.getOwnPropertyDescriptor(target, property);
      const locked =
        own?.configurable === false &&
        ('value' in own ? own.writable === false : own.get === undefined);
      const value: unknown = Reflect.get(target, property, target);
      if (locked) return value;
      if (property === 'request') return request;
      if (typeof value !== 'function') return value;
      // Methods keep the original provider as `this`: class-based providers
      // hold private state that a proxy cannot stand in for.
      let method = bound.get(property);
      if (method === undefined) {
        method = (...args: unknown[]): unknown => Reflect.apply(value, target, args);
        bound.set(property, method);
      }
      return method;
    },
  });
}
