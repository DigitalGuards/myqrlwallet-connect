import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setDebug, log, warn, error } from '../src/utils/logger.js';

describe('logger', () => {
  let consoleSpy: {
    log: ReturnType<typeof vi.spyOn>;
    warn: ReturnType<typeof vi.spyOn>;
    error: ReturnType<typeof vi.spyOn>;
  };

  beforeEach(() => {
    consoleSpy = {
      log: vi.spyOn(console, 'log').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    setDebug(false);
    vi.restoreAllMocks();
  });

  describe('log (debug level)', () => {
    it('should not log when debug is disabled', () => {
      setDebug(false);
      log('Test', 'message');
      expect(consoleSpy.log).not.toHaveBeenCalled();
    });

    it('should log when debug is enabled', () => {
      setDebug(true);
      log('Test', 'message');
      expect(consoleSpy.log).toHaveBeenCalledWith('[QRLConnect:Test]', 'message');
    });

    it('should format tag correctly', () => {
      setDebug(true);
      log('Socket', 'connected');
      expect(consoleSpy.log).toHaveBeenCalledWith('[QRLConnect:Socket]', 'connected');
    });

    it('should pass multiple arguments', () => {
      setDebug(true);
      log('Test', 'a', 'b', 123);
      expect(consoleSpy.log).toHaveBeenCalledWith('[QRLConnect:Test]', 'a', 'b', 123);
    });
  });

  describe('warn', () => {
    it('should always log warnings regardless of debug setting', () => {
      setDebug(false);
      warn('Test', 'warning');
      expect(consoleSpy.warn).toHaveBeenCalledWith('[QRLConnect:Test]', 'warning');
    });
  });

  describe('error', () => {
    it('should always log errors regardless of debug setting', () => {
      setDebug(false);
      error('Test', 'error');
      expect(consoleSpy.error).toHaveBeenCalledWith('[QRLConnect:Test]', 'error');
    });
  });
});
