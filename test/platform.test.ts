import { describe, it, expect, vi, afterEach } from 'vitest';
import { isMobileBrowser, getAppStoreUrl } from '../src/utils/platform.js';

describe('platform utilities', () => {
  const originalNavigator = globalThis.navigator;

  afterEach(() => {
    Object.defineProperty(globalThis, 'navigator', {
      value: originalNavigator,
      configurable: true,
    });
  });

  function mockUserAgent(ua: string) {
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: ua },
      configurable: true,
    });
  }

  describe('isMobileBrowser', () => {
    it('should return false when navigator is undefined', () => {
      Object.defineProperty(globalThis, 'navigator', {
        value: undefined,
        configurable: true,
      });
      expect(isMobileBrowser()).toBe(false);
    });

    it('should detect Android', () => {
      mockUserAgent(
        'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36'
      );
      expect(isMobileBrowser()).toBe(true);
    });

    it('should detect iPhone', () => {
      mockUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
      );
      expect(isMobileBrowser()).toBe(true);
    });

    it('should detect iPad', () => {
      mockUserAgent(
        'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
      );
      expect(isMobileBrowser()).toBe(true);
    });

    it('should return false for desktop browsers', () => {
      mockUserAgent(
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );
      expect(isMobileBrowser()).toBe(false);
    });
  });

  describe('getAppStoreUrl', () => {
    it('should return Play Store URL for Android', () => {
      mockUserAgent('Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36');
      expect(getAppStoreUrl()).toContain('play.google.com');
    });

    it('should return App Store URL for iOS/other', () => {
      mockUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'
      );
      expect(getAppStoreUrl()).toContain('apps.apple.com');
    });

    it('should default to App Store when navigator is undefined', () => {
      Object.defineProperty(globalThis, 'navigator', {
        value: undefined,
        configurable: true,
      });
      expect(getAppStoreUrl()).toContain('apps.apple.com');
    });
  });
});
