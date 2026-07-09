/**
 * Detect if the current browser is on a mobile device.
 */
export function isMobileBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod|Opera Mini|IEMobile|WPDesktop/i.test(navigator.userAgent);
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

/**
 * Attempt to open a `qrlconnect://` URI in the wallet app and report whether
 * anything handled it.
 *
 * A custom-scheme navigation on a device without the app installed fails
 * silently on Android and with a blocking alert on iOS Safari, leaving the
 * page visible either way. When the app IS installed, the OS backgrounds the
 * browser, firing `visibilitychange`/`pagehide` almost immediately. So:
 * navigate, then resolve `true` as soon as the page hides, or `false` if it
 * is still visible after `timeoutMs`. On `false`, show fallback pairing UI
 * (QR / copy-code) and an install link (`getAppStoreUrl()`).
 *
 * Detection is heuristic by nature: a slow device may hide the page late
 * (harmless, the wallet still opens), and it cannot distinguish "app missing"
 * from "user dismissed the OS chooser". Treat `false` as "show a fallback",
 * never as proof the app is absent.
 */
export function attemptWalletRedirect(uri: string, timeoutMs = 1800): Promise<boolean> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.resolve(false);
  }
  // Defense in depth: this helper exists for qrlconnect:// deep links only.
  // Anything else (javascript:, data:, ...) resolves false without
  // navigating, even though callers normally pass SDK-generated URIs.
  if (!uri.trim().toLowerCase().startsWith('qrlconnect:')) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (opened: boolean): void => {
      if (settled) return;
      settled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onHide);
      window.clearTimeout(timer);
      resolve(opened);
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') finish(true);
    };
    const onHide = (): void => {
      finish(true);
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onHide);
    // finish() closes over this; nothing can invoke it synchronously between
    // the listener registrations above and this initialization.
    const timer = window.setTimeout(() => {
      finish(false);
    }, timeoutMs);
    try {
      window.location.href = uri;
    } catch {
      // Navigation can throw synchronously (sandboxing, policy); settle
      // instead of leaking the listeners and timer.
      finish(false);
    }
  });
}
