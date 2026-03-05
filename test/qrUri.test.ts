import { describe, it, expect } from 'vitest';
import { generateConnectionURI, parseConnectionURI } from '../src/utils/qrUri.js';

describe('qrUri', () => {
  const baseParams = {
    channelId: 'test-channel-123',
    pubKey: 'abcdef1234567890',
    name: 'Test DApp',
    url: 'https://testdapp.com',
    chainId: '0x0',
    relayUrl: 'https://qrlwallet.com',
  };

  describe('generateConnectionURI', () => {
    it('should generate a valid qrlconnect:// URI', () => {
      const uri = generateConnectionURI(baseParams);
      expect(uri).toMatch(/^qrlconnect:\/\/\?/);
    });

    it('should include all required parameters', () => {
      const uri = generateConnectionURI(baseParams);
      expect(uri).toContain('channelId=test-channel-123');
      expect(uri).toContain('pubKey=abcdef1234567890');
      expect(uri).toContain('name=Test+DApp');
      expect(uri).toContain('chainId=0x0');
    });

    it('should include icon when provided', () => {
      const uri = generateConnectionURI({
        ...baseParams,
        icon: 'https://testdapp.com/icon.png',
      });
      expect(uri).toContain('icon=');
    });

    it('should not include icon when not provided', () => {
      const uri = generateConnectionURI(baseParams);
      expect(uri).not.toContain('icon=');
    });

    it('should URL-encode special characters', () => {
      const uri = generateConnectionURI({
        ...baseParams,
        name: 'My DApp & More',
      });
      expect(uri).toContain('name=My+DApp+%26+More');
    });
  });

  describe('parseConnectionURI', () => {
    it('should parse a generated URI back to original params', () => {
      const uri = generateConnectionURI(baseParams);
      const parsed = parseConnectionURI(uri);

      expect(parsed).not.toBeNull();
      expect(parsed!.channelId).toBe(baseParams.channelId);
      expect(parsed!.pubKey).toBe(baseParams.pubKey);
      expect(parsed!.name).toBe(baseParams.name);
      expect(parsed!.url).toBe(baseParams.url);
      expect(parsed!.chainId).toBe(baseParams.chainId);
      expect(parsed!.relayUrl).toBe(baseParams.relayUrl);
    });

    it('should parse URI with icon', () => {
      const params = { ...baseParams, icon: 'https://testdapp.com/icon.png' };
      const uri = generateConnectionURI(params);
      const parsed = parseConnectionURI(uri);

      expect(parsed!.icon).toBe(params.icon);
    });

    it('should return undefined icon when not present', () => {
      const uri = generateConnectionURI(baseParams);
      const parsed = parseConnectionURI(uri);
      expect(parsed!.icon).toBeUndefined();
    });

    it('should handle qrlconnect:? format (single slash)', () => {
      const uri = `qrlconnect:?channelId=${baseParams.channelId}&pubKey=${baseParams.pubKey}&name=${baseParams.name}&url=${baseParams.url}&chainId=${baseParams.chainId}&relay=${baseParams.relayUrl}`;
      const parsed = parseConnectionURI(uri);
      expect(parsed).not.toBeNull();
      expect(parsed!.channelId).toBe(baseParams.channelId);
    });

    it('should return null for missing required fields', () => {
      expect(parseConnectionURI('qrlconnect://?channelId=test')).toBeNull();
      expect(parseConnectionURI('qrlconnect://?')).toBeNull();
      expect(parseConnectionURI('qrlconnect://?channelId=test&pubKey=abc')).toBeNull();
    });

    it('should return null for invalid URI', () => {
      expect(parseConnectionURI('')).toBeNull();
    });

    it('should roundtrip with special characters', () => {
      const params = {
        ...baseParams,
        name: 'DApp With Spaces & Symbols!',
        url: 'https://example.com/path?q=1&r=2',
      };
      const uri = generateConnectionURI(params);
      const parsed = parseConnectionURI(uri);

      expect(parsed!.name).toBe(params.name);
      expect(parsed!.url).toBe(params.url);
    });
  });
});
