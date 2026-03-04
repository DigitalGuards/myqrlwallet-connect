/**
 * Detect if the current browser is on a mobile device.
 */
export function isMobileBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod|Opera Mini|IEMobile|WPDesktop/i.test(
    navigator.userAgent
  );
}

/**
 * Check if the QRL Wallet app is likely installed by attempting a deep link.
 * Falls back to app store URL after timeout.
 */
export function getAppStoreUrl(): string {
  if (typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent)) {
    return 'https://play.google.com/store/apps/details?id=com.chiefdg.myqrlwallet';
  }
  return 'https://apps.apple.com/app/myqrlwallet/id6742219498';
}
