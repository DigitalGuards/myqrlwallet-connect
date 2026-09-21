export const QRL_ZERO_ADDRESS = `Q${'0'.repeat(128)}`;
export const DEFAULT_DEMO_CHAIN_ID = '3151909';

/** Convert a decimal QRL amount without rounding through floating point. */
export function parseQuanta(value) {
  if (typeof value !== 'string' || value.length > 100 || !/^\d+(?:\.\d{1,18})?$/.test(value)) {
    throw new Error('Enter a non-negative decimal amount with at most 18 decimal places');
  }
  const [whole, fraction = ''] = value.split('.');
  const amount = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
  if (amount >= 1n << 256n) throw new Error('Amount exceeds the transaction limit');
  return amount;
}

/** Keep the chain returned by the connected wallet in canonical hex form. */
export function canonicalChainId(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(value) || BigInt(value) === 0n) {
    throw new Error('Wallet returned an invalid chain ID');
  }
  return `0x${BigInt(value).toString(16)}`;
}

/** Unsupported address-bearing typed data, used only by the local rejection probe. */
export function makeTypedRejectionPayload(account, chainId, now = Date.now()) {
  return {
    types: {
      QRLDomain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      ExampleIntent: [
        { name: 'account', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'deadline', type: 'uint64' },
      ],
    },
    primaryType: 'ExampleIntent',
    domain: {
      name: 'QRL Connect local rejection demo',
      version: '1',
      chainId: chainId ? BigInt(canonicalChainId(chainId)).toString() : DEFAULT_DEMO_CHAIN_ID,
      verifyingContract: QRL_ZERO_ADDRESS,
    },
    message: {
      account: account || QRL_ZERO_ADDRESS,
      amount: '1000000000000000000',
      deadline: String(Math.floor(now / 1000) + 3600),
    },
  };
}
