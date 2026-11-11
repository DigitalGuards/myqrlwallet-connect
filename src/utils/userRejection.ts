const USER_REJECTED_CODE = 4001;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasRejectionCode(value: unknown): boolean {
  return isRecord(value) && value.code === USER_REJECTED_CODE;
}

/**
 * True when a failed wallet request ended at the wallet with code 4001, before
 * anything was broadcast.
 *
 * Use it in the `catch` of `provider.request(...)` to tell "the wallet did not
 * go through with it" from a failure on the dApp or transport side. The code
 * covers more than a user pressing Reject. MyQRLWallet relay wallets answer
 * most failures they detect before broadcasting with 4001 too (no stored seed,
 * a failed signature, the node refusing the broadcast with "Insufficient
 * funds"), and the SDK passes that code on. The reason is in `error.message`,
 * so show it to the user.
 *
 * It reads machine signals only and never matches message text:
 *
 * - EIP-1193 `code` 4001 on the error itself. The SDK's own provider rejects
 *   with `Object.assign(new Error(message), { code })`.
 * - `code` 4001 on `error.info.error` (the wrapper ethers v6 builds), on
 *   `error.innerError` (the wrapper the web3.js stack builds) or on `error.cause`.
 * - The ethers code `"ACTION_REJECTED"`.
 *
 * Anything else returns false, including strings, `null` and other numeric
 * codes. It never throws: an error object whose getters throw yields false.
 *
 * @example
 * try {
 *   await provider.request({ method: 'qrl_sendTransaction', params: [tx] });
 * } catch (error) {
 *   if (isUserRejection(error)) showMessage(`Not approved in the wallet: ${error.message}`);
 *   else showMessage('Request failed.');
 * }
 */
export function isUserRejection(error: unknown): boolean {
  try {
    if (!isRecord(error)) return false;
    if (error.code === 'ACTION_REJECTED' || error.code === USER_REJECTED_CODE) return true;
    const info = error.info;
    if (isRecord(info) && hasRejectionCode(info.error)) return true;
    return hasRejectionCode(error.innerError) || hasRejectionCode(error.cause);
  } catch {
    return false;
  }
}
