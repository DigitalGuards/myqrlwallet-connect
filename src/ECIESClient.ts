/**
 * ECIES encryption/decryption client.
 * Adapted from MetaMask SDK's ECIES.ts pattern.
 */

import { PrivateKey, decrypt, encrypt } from 'eciesjs';
import { log } from './utils/logger.js';

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
    const encrypted = encrypt(otherPublicKey, Buffer.from(data, 'utf8'));
    return Buffer.from(encrypted).toString('base64');
  }

  /** Decrypt a base64-encoded message using our private key. */
  decrypt(encryptedBase64: string): string {
    const encryptedBuffer = Buffer.from(encryptedBase64, 'base64');
    const decrypted = decrypt(this.privateKey.toHex(), encryptedBuffer);
    return Buffer.from(decrypted).toString('utf8');
  }
}
