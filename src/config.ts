export const DEFAULT_RELAY_URL = 'https://qrlwallet.com';
export const RELAY_PATH = '/relay';
export const PROTOCOL_VERSION = 2;
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const STORAGE_KEY_PREFIX = '@qrlwallet/connect';
export const REQUEST_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
export const WALLET_UNRESPONSIVE_MS = 30 * 1000; // 30 seconds
// After re-joining a restored session's channel with no wallet present, how
// long to wait for the wallet to (re)appear before declaring the reconnect
// dead and surfacing DISCONNECTED so the dApp can fall back to a fresh QR.
// Comfortably longer than an observed iOS background-resume (~8s) so a merely
// backgrounded wallet is not torn down, but short enough to avoid an
// indefinite "reconnecting…" hang when the wallet is genuinely gone.
export const RECONNECT_WALLET_PROBE_MS = 12 * 1000; // 12 seconds

// Current network address format. The planned wider address format is a
// separate protocol migration and must not be accepted implicitly here.
const CURRENT_QRL_ADDRESS_RE = /^Q[0-9a-fA-F]{40}$/;

export function isCurrentQrlAddress(value: unknown): value is string {
  return typeof value === 'string' && CURRENT_QRL_ADDRESS_RE.test(value);
}

/**
 * RPC methods that require user approval in the wallet.
 *
 * v3.0.0 replaces the Ethereum-flavored signing surface with two
 * post-quantum-native methods: `qrl_signMessage` for opaque bytes and
 * `qrl_signTypedData` for structured payloads (EIP-712-shaped, but with
 * SHAKE256 + native Dilithium ctx). The legacy methods (`personal_sign`,
 * `qrl_sign`, `qrl_signTypedData_v3`, `qrl_signTypedData_v4`) are no
 * longer accepted; a dApp calling them via this SDK will get a
 * "method not supported" error before the relay round-trip.
 */
const RESTRICTED_METHOD_NAMES = [
  'qrl_requestAccounts',
  'qrl_sendTransaction',
  'qrl_signTransaction',
  'qrl_signMessage',
  'qrl_signTypedData',
  'wallet_addQrlChain',
  'wallet_switchQrlChain',
] as const;

/** RPC methods that can be auto-proxied without approval */
const UNRESTRICTED_METHOD_NAMES = [
  'qrl_chainId',
  'qrl_blockNumber',
  'qrl_getBalance',
  'qrl_getTransactionCount',
  'qrl_getBlockByNumber',
  'qrl_getBlockByHash',
  'qrl_getTransactionByHash',
  'qrl_getTransactionReceipt',
  'qrl_call',
  'qrl_estimateGas',
  'qrl_gasPrice',
  'qrl_getCode',
  'qrl_getStorageAt',
  'qrl_getLogs',
  'qrl_getBlockTransactionCountByHash',
  'qrl_getBlockTransactionCountByNumber',
  'qrl_getTransactionByBlockHashAndIndex',
  'qrl_getTransactionByBlockNumberAndIndex',
  'qrl_accounts',
  'net_version',
  'net_listening',
  'net_peerCount',
  'web3_clientVersion',
  'web3_sha3',
  'qrl_syncing',
  'qrl_coinbase',
  'qrl_mining',
  'qrl_hashrate',
  'qrl_protocolVersion',
  'qrl_getUncleCountByBlockHash',
  'qrl_getUncleCountByBlockNumber',
  'qrl_getUncleByBlockHashAndIndex',
  'qrl_getUncleByBlockNumberAndIndex',
  'qrl_getFilterChanges',
  'qrl_getFilterLogs',
  'qrl_newBlockFilter',
  'qrl_newFilter',
  'qrl_newPendingTransactionFilter',
  'qrl_uninstallFilter',
] as const;

/**
 * Methods that must never be forwarded by QRL Connect. Raw transaction
 * broadcast is state changing but has no wallet-owned approval or signing
 * step. Legacy and unknown signing surfaces are rejected for the same reason.
 */
const EXPLICITLY_UNSUPPORTED_METHOD_NAMES = [
  'qrl_sendRawTransaction',
  'personal_sign',
  'qrl_sign',
  'qrl_signTypedData_v3',
  'qrl_signTypedData_v4',
] as const;

const RESTRICTED_METHOD_POLICY = new Set<string>(RESTRICTED_METHOD_NAMES);
const UNRESTRICTED_METHOD_POLICY = new Set<string>(UNRESTRICTED_METHOD_NAMES);
const EXPLICITLY_UNSUPPORTED_METHOD_POLICY = new Set<string>(EXPLICITLY_UNSUPPORTED_METHOD_NAMES);

/** Public snapshots for discovery. Provider authorization uses private sets. */
export const RESTRICTED_METHODS: ReadonlySet<string> = new Set(RESTRICTED_METHOD_NAMES);
export const UNRESTRICTED_METHODS: ReadonlySet<string> = new Set(UNRESTRICTED_METHOD_NAMES);
export const EXPLICITLY_UNSUPPORTED_METHODS: ReadonlySet<string> = new Set(
  EXPLICITLY_UNSUPPORTED_METHOD_NAMES
);

export type RpcMethodPolicy = 'restricted' | 'unrestricted' | 'unsupported';

/**
 * Classify an RPC method with a closed allowlist. Any method absent from the
 * two positive policy sets is unsupported, including future signing methods.
 */
export function classifyRpcMethod(method: string): RpcMethodPolicy {
  if (EXPLICITLY_UNSUPPORTED_METHOD_POLICY.has(method)) return 'unsupported';
  if (RESTRICTED_METHOD_POLICY.has(method)) return 'restricted';
  if (UNRESTRICTED_METHOD_POLICY.has(method)) return 'unrestricted';
  return 'unsupported';
}
