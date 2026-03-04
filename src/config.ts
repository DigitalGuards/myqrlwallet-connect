export const DEFAULT_RELAY_URL = 'https://qrlwallet.com';
export const RELAY_PATH = '/relay';
export const PROTOCOL_VERSION = 1;
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const STORAGE_KEY_PREFIX = '@qrlwallet/connect';
export const REQUEST_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
export const WALLET_UNRESPONSIVE_MS = 30 * 1000; // 30 seconds

/** RPC methods that require user approval in the wallet */
export const RESTRICTED_METHODS = new Set([
  'zond_requestAccounts',
  'zond_sendTransaction',
  'zond_signTransaction',
  'zond_sign',
  'personal_sign',
  'zond_signTypedData',
  'zond_signTypedData_v3',
  'zond_signTypedData_v4',
  'wallet_addZondChain',
  'wallet_switchZondChain',
]);

/** RPC methods that can be auto-proxied without approval */
export const UNRESTRICTED_METHODS = new Set([
  'zond_chainId',
  'zond_blockNumber',
  'zond_getBalance',
  'zond_getTransactionCount',
  'zond_getBlockByNumber',
  'zond_getBlockByHash',
  'zond_getTransactionByHash',
  'zond_getTransactionReceipt',
  'zond_call',
  'zond_estimateGas',
  'zond_gasPrice',
  'zond_getCode',
  'zond_getStorageAt',
  'zond_getLogs',
  'zond_getBlockTransactionCountByHash',
  'zond_getBlockTransactionCountByNumber',
  'zond_getTransactionByBlockHashAndIndex',
  'zond_getTransactionByBlockNumberAndIndex',
  'zond_accounts',
  'net_version',
  'net_listening',
  'net_peerCount',
  'web3_clientVersion',
  'web3_sha3',
  'zond_syncing',
  'zond_coinbase',
  'zond_mining',
  'zond_hashrate',
  'zond_protocolVersion',
  'zond_getUncleCountByBlockHash',
  'zond_getUncleCountByBlockNumber',
  'zond_getUncleByBlockHashAndIndex',
  'zond_getUncleByBlockNumberAndIndex',
  'zond_getFilterChanges',
  'zond_getFilterLogs',
  'zond_newBlockFilter',
  'zond_newFilter',
  'zond_newPendingTransactionFilter',
  'zond_uninstallFilter',
]);
