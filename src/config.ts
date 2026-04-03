export const DEFAULT_RELAY_URL = 'https://qrlwallet.com';
export const RELAY_PATH = '/relay';
export const PROTOCOL_VERSION = 1;
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const STORAGE_KEY_PREFIX = '@qrlwallet/connect';
export const REQUEST_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
export const WALLET_UNRESPONSIVE_MS = 30 * 1000; // 30 seconds

/** RPC methods that require user approval in the wallet */
export const RESTRICTED_METHODS = new Set([
  'qrl_requestAccounts',
  'qrl_sendTransaction',
  'qrl_signTransaction',
  'qrl_sign',
  'personal_sign',
  'qrl_signTypedData',
  'qrl_signTypedData_v3',
  'qrl_signTypedData_v4',
  'wallet_addQrlChain',
  'wallet_switchQrlChain',
]);

/** RPC methods that can be auto-proxied without approval */
export const UNRESTRICTED_METHODS = new Set([
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
]);
