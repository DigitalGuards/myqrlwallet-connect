import { describe, it, expect } from 'vitest';
import { ECIESClient } from '../src/ECIESClient.js';

describe('ECIESClient', () => {
  describe('key generation', () => {
    it('should generate a new keypair', () => {
      const client = new ECIESClient();
      expect(client.getPublicKey()).toBeTruthy();
      expect(client.getPrivateKeyHex()).toBeTruthy();
    });

    it('should generate unique keypairs', () => {
      const client1 = new ECIESClient();
      const client2 = new ECIESClient();
      expect(client1.getPublicKey()).not.toBe(client2.getPublicKey());
      expect(client1.getPrivateKeyHex()).not.toBe(client2.getPrivateKeyHex());
    });

    it('should return hex-encoded public key', () => {
      const client = new ECIESClient();
      expect(client.getPublicKey()).toMatch(/^[0-9a-f]+$/i);
    });

    it('should return hex-encoded private key', () => {
      const client = new ECIESClient();
      expect(client.getPrivateKeyHex()).toMatch(/^[0-9a-f]+$/i);
    });
  });

  describe('key restoration', () => {
    it('should restore from an existing private key', () => {
      const original = new ECIESClient();
      const privateKeyHex = original.getPrivateKeyHex();
      const publicKey = original.getPublicKey();

      const restored = new ECIESClient(privateKeyHex);
      expect(restored.getPublicKey()).toBe(publicKey);
      expect(restored.getPrivateKeyHex()).toBe(privateKeyHex);
    });
  });

  describe('encrypt/decrypt', () => {
    it('should encrypt and decrypt a message between two clients', () => {
      const alice = new ECIESClient();
      const bob = new ECIESClient();

      const plaintext = 'Hello, Bob!';
      const encrypted = alice.encrypt(plaintext, bob.getPublicKey());

      expect(encrypted).not.toBe(plaintext);
      expect(typeof encrypted).toBe('string');

      const decrypted = bob.decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it('should handle JSON payloads', () => {
      const alice = new ECIESClient();
      const bob = new ECIESClient();

      const payload = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'zond_getBalance',
        params: ['Z1234567890abcdef', 'latest'],
      });

      const encrypted = alice.encrypt(payload, bob.getPublicKey());
      const decrypted = bob.decrypt(encrypted);
      expect(JSON.parse(decrypted)).toEqual(JSON.parse(payload));
    });

    it('should handle empty strings', () => {
      const alice = new ECIESClient();
      const bob = new ECIESClient();

      const encrypted = alice.encrypt('', bob.getPublicKey());
      const decrypted = bob.decrypt(encrypted);
      expect(decrypted).toBe('');
    });

    it('should handle unicode characters', () => {
      const alice = new ECIESClient();
      const bob = new ECIESClient();

      const message = 'Hello 世界! 🌍';
      const encrypted = alice.encrypt(message, bob.getPublicKey());
      const decrypted = bob.decrypt(encrypted);
      expect(decrypted).toBe(message);
    });

    it('should handle large payloads', () => {
      const alice = new ECIESClient();
      const bob = new ECIESClient();

      const largePayload = 'x'.repeat(10000);
      const encrypted = alice.encrypt(largePayload, bob.getPublicKey());
      const decrypted = bob.decrypt(encrypted);
      expect(decrypted).toBe(largePayload);
    });

    it('should produce different ciphertext for same plaintext', () => {
      const alice = new ECIESClient();
      const bob = new ECIESClient();

      const plaintext = 'same message';
      const encrypted1 = alice.encrypt(plaintext, bob.getPublicKey());
      const encrypted2 = alice.encrypt(plaintext, bob.getPublicKey());

      // ECIES uses ephemeral keys, so same plaintext -> different ciphertext
      expect(encrypted1).not.toBe(encrypted2);
    });

    it('should fail to decrypt with wrong private key', () => {
      const alice = new ECIESClient();
      const bob = new ECIESClient();
      const eve = new ECIESClient();

      const encrypted = alice.encrypt('secret', bob.getPublicKey());
      expect(() => eve.decrypt(encrypted)).toThrow();
    });

    it('should support bidirectional encryption', () => {
      const alice = new ECIESClient();
      const bob = new ECIESClient();

      const msgToAlice = bob.encrypt('Hello Alice', alice.getPublicKey());
      const msgToBob = alice.encrypt('Hello Bob', bob.getPublicKey());

      expect(alice.decrypt(msgToAlice)).toBe('Hello Alice');
      expect(bob.decrypt(msgToBob)).toBe('Hello Bob');
    });
  });
});
