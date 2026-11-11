const USER_REJECTED_CODE = 4001;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * True when a failed wallet request means "the user declined the prompt".
 *
 * Use it in the `catch` of `provider.request(...)` to tell a decline, which
 * needs no error screen, from a real failure. It reads machine signals only
 * and never matches message text:
 *
 * - EIP-1193 `code` 4001 on the error itself. The SDK's own provider rejects
 *   with `Object.assign(new Error(message), { code })`.
 * - `code` 4001 on `error.info.error` (the wrapper ethers v6 builds around a
 *   provider rejection) or on `error.cause`.
 * - The ethers code `"ACTION_REJECTED"`.
 *
 * Anything else returns false, including strings, `null` and other numeric
 * codes. A decline happens at signing time, before any broadcast, so nothing
 * reached the chain.
 *
 * @example
 * try {
 *   await provider.request({ method: 'qrl_sendTransaction', params: [tx] });
 * } catch (error) {
 *   showMessage(isUserRejection(error) ? 'Request declined in the wallet.' : 'Request failed.');
 * }
 */
export function isUserRejection(error: unknown): boolean {
  if (!isRecord(error)) return false;
  if (error.code === 'ACTION_REJECTED' || error.code === USER_REJECTED_CODE) return true;
  const info = error.info;
  if (isRecord(info) && isRecord(info.error) && info.error.code === USER_REJECTED_CODE) {
    return true;
  }
  return isRecord(error.cause) && error.cause.code === USER_REJECTED_CODE;
}
