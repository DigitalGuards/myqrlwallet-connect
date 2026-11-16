// Counts the wallet requests that wait for the user, at the place they are
// sent. A request is open from the moment it goes to the wallet until the
// wallet answers (a hash, a signature, a rejection or an error): exactly the
// time a wallet prompt can sit unseen behind its toolbar icon or on another
// device. Reads, simulations and the wait for a receipt never count.
//
// Plain functions with no DOM and no framework. <qrl-approval-hint> shows the
// result; bindApprovalHint() in approval.ts connects the two.

/** Methods a wallet answers only after the user has looked at a prompt. */
const APPROVAL_METHODS: ReadonlySet<string> = new Set([
  'eth_requestAccounts',
  'eth_sendTransaction',
  'eth_sign',
  'personal_sign',
  'eth_signTypedData',
  'eth_signTypedData_v3',
  'eth_signTypedData_v4',
  'wallet_requestPermissions',
  'wallet_switchEthereumChain',
  'wallet_addEthereumChain',
  'wallet_watchAsset',
  'qrl_requestAccounts',
  'qrl_sendTransaction',
  'qrl_signTransaction',
  'qrl_signMessage',
  'qrl_signTypedData',
  'wallet_switchQrlChain',
  'wallet_addQrlChain',
]);

/** True for a JSON-RPC method that makes a wallet prompt its user. */
export const isApprovalMethod = (method: string): boolean => APPROVAL_METHODS.has(method);

/** The open wallet requests of one wallet connection. */
export interface ApprovalRequests {
  /** Runs one wallet request and counts it as open until it settles. */
  track<T>(run: () => Promise<T>): Promise<T>;
  /** True while at least one tracked request is open. */
  pending(): boolean;
  /** Calls `listener` whenever a request opens or settles. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

/** A counter for one wallet connection. Use one per wallet, so a hint can name the right one. */
export function createApprovalRequests(): ApprovalRequests {
  let open = 0;
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  return {
    async track<T>(run: () => Promise<T>): Promise<T> {
      open += 1;
      notify();
      try {
        return await run();
      } finally {
        open -= 1;
        notify();
      }
    },
    pending: () => open > 0,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
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
 * The provider's `request` with its prompting calls counted. Pass the result
 * wherever the dApp sends wallet requests (for example to an ethers
 * `BrowserProvider`). Events stay on the original provider.
 */
export function trackedProvider(
  provider: ApprovalRequestProvider,
  approvals: ApprovalRequests
): ApprovalRequestProvider {
  return {
    request: (args) =>
      isApprovalMethod(args.method)
        ? approvals.track(() => provider.request(args))
        : provider.request(args),
  };
}
