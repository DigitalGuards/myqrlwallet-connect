/**
 * ECIES encryption/decryption client.
 * Adapted from MetaMask SDK's ECIES.ts pattern.
 */

import { PrivateKey, decrypt, encrypt } from 'eciesjs';
import { log } from './utils/logger.js';

/** Convert Uint8Array to base64 string (browser-safe, no Buffer needed). */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Convert base64 string to Uint8Array (browser-safe, no Buffer needed). */
function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export class ECIESClient {
  private privateKey: PrivateKey;

  constructor(existingPrivateKey?: string) {
    if (existingPrivateKey) {
      this.privateKey = PrivateKey.fromHex(existingPrivateKey);
      log('ECIES', 'Restored from existing private key');
    } else {
      this.privateKey = new PrivateKey();
      log('ECIES', 'Generated new ECIES keypair');
    }
  }

  /** Get public key as hex string */
  getPublicKey(): string {
    return this.privateKey.publicKey.toHex();
  }

  /** Get private key as hex string (for session persistence) */
  getPrivateKeyHex(): string {
    return this.privateKey.toHex();
  }

  /** Encrypt a string message for the given public key. Returns base64. */
  encrypt(data: string, otherPublicKey: string): string {
    const encoded = new TextEncoder().encode(data);
    const encrypted = encrypt(otherPublicKey, encoded);
    return toBase64(encrypted);
  }

  /** Decrypt a base64-encoded message using our private key. */
  decrypt(encryptedBase64: string): string {
    const encryptedBytes = fromBase64(encryptedBase64);
    const decrypted = decrypt(this.privateKey.toHex(), encryptedBytes);
    return new TextDecoder().decode(decrypted);
  }
}
