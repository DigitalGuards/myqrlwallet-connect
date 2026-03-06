/**
 * Key Exchange - 3-step SYN/SYNACK/ACK handshake protocol.
 * Adapted from MetaMask SDK's KeyExchange.ts.
 */

import EventEmitter from 'eventemitter3';
import { ECIESClient } from './ECIESClient.js';
import { PROTOCOL_VERSION } from './config.js';
import { KeyExchangeMessageType } from './types.js';
import { log, warn } from './utils/logger.js';

interface KeyExchangeEvents {
  keys_exchanged: () => void;
  step_change: (step: KeyExchangeMessageType) => void;
}

export class KeyExchange extends EventEmitter<KeyExchangeEvents> {
  private ecies: ECIESClient;
  private otherPublicKey: string | null = null;
  private keysExchanged = false;
  private awaitingSynAck = false;
  private awaitingAck = false;
  private step: KeyExchangeMessageType = KeyExchangeMessageType.SYN;
  private isOriginator: boolean;

  constructor(ecies: ECIESClient, isOriginator: boolean, otherPublicKey?: string) {
    super();
    this.ecies = ecies;
    this.isOriginator = isOriginator;

    if (otherPublicKey) {
      this.otherPublicKey = otherPublicKey;
      this.keysExchanged = true;
      log('KeyExchange', 'Restored with existing other public key');
    }
  }

  /** Get the SYN message to start the handshake (originator/dApp side). */
  createSYN(): object {
    this.step = KeyExchangeMessageType.SYN;
    this.awaitingSynAck = true;
    this.emit('step_change', this.step);

    return {
      type: KeyExchangeMessageType.SYN,
      pubkey: this.ecies.getPublicKey(),
      v: PROTOCOL_VERSION,
    };
  }

  /**
   * Process an incoming key exchange message.
   * Returns a response message to send back, or null if handshake is complete.
   */
  onMessage(message: { type: KeyExchangeMessageType; pubkey?: string; v?: number }): object | null {
    log('KeyExchange', `Received ${message.type}, isOriginator=${this.isOriginator}`);

    switch (message.type) {
      case KeyExchangeMessageType.SYN: {
        // Wallet receives SYN from dApp
        if (this.isOriginator) {
          warn('KeyExchange', 'Originator received SYN - ignoring');
          return null;
        }

        if (message.pubkey) {
          this.otherPublicKey = message.pubkey;
        }

        this.step = KeyExchangeMessageType.SYNACK;
        this.awaitingAck = true;
        this.emit('step_change', this.step);

        // Respond with SYNACK containing wallet's public key
        return {
          type: KeyExchangeMessageType.SYNACK,
          pubkey: this.ecies.getPublicKey(),
          v: PROTOCOL_VERSION,
        };
      }

      case KeyExchangeMessageType.SYNACK: {
        // dApp receives SYNACK from wallet
        if (!this.isOriginator) {
          warn('KeyExchange', 'Non-originator received SYNACK - ignoring');
          return null;
        }

        if (message.pubkey) {
          this.otherPublicKey = message.pubkey;
        }

        if (!this.awaitingSynAck) {
          // Duplicate/late SYNACK - re-send ACK but do not re-emit keys_exchanged.
          return {
            type: KeyExchangeMessageType.ACK,
            v: PROTOCOL_VERSION,
          };
        }
        this.awaitingSynAck = false;

        this.step = KeyExchangeMessageType.ACK;
        if (!this.keysExchanged) {
          this.keysExchanged = true;
          this.emit('keys_exchanged');
        }
        this.emit('step_change', this.step);

        // Send ACK to confirm
        return {
          type: KeyExchangeMessageType.ACK,
          v: PROTOCOL_VERSION,
        };
      }

      case KeyExchangeMessageType.ACK: {
        // Wallet receives ACK from dApp - handshake complete
        if (this.isOriginator) {
          warn('KeyExchange', 'Originator received ACK - ignoring');
          return null;
        }

        if (!this.awaitingAck) {
          // Duplicate/late ACK - ignore
          return null;
        }
        this.awaitingAck = false;

        if (!this.keysExchanged) {
          this.keysExchanged = true;
          this.emit('keys_exchanged');
        }
        log('KeyExchange', 'Key exchange complete (wallet side)');
        return null;
      }

      default:
        warn('KeyExchange', `Unknown key exchange type: ${message.type}`);
        return null;
    }
  }

  /** Encrypt a message for the counterparty. */
  encryptMessage(data: string): string {
    if (!this.otherPublicKey) {
      throw new Error('Cannot encrypt: key exchange not complete');
    }
    return this.ecies.encrypt(data, this.otherPublicKey);
  }

  /** Decrypt a message from the counterparty. */
  decryptMessage(encryptedBase64: string): string {
    return this.ecies.decrypt(encryptedBase64);
  }

  /** Reset key exchange state for a fresh handshake (e.g. new QR code). */
  reset(): void {
    this.otherPublicKey = null;
    this.keysExchanged = false;
    this.awaitingSynAck = false;
    this.awaitingAck = false;
    this.step = KeyExchangeMessageType.SYN;
    log('KeyExchange', 'Reset for fresh handshake');
  }

  areKeysExchanged(): boolean {
    return this.keysExchanged;
  }

  getOtherPublicKey(): string | null {
    return this.otherPublicKey;
  }

  getCurrentStep(): KeyExchangeMessageType {
    return this.step;
  }
}
