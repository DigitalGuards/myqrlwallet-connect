import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ECIESClient } from '../src/ECIESClient.js';
import { KeyExchange } from '../src/KeyExchange.js';
import { KeyExchangeMessageType } from '../src/types.js';
import { PROTOCOL_VERSION } from '../src/config.js';

describe('KeyExchange', () => {
  let dappEcies: ECIESClient;
  let walletEcies: ECIESClient;
  let dappKex: KeyExchange;
  let walletKex: KeyExchange;

  beforeEach(() => {
    dappEcies = new ECIESClient();
    walletEcies = new ECIESClient();
    dappKex = new KeyExchange(dappEcies, true); // originator
    walletKex = new KeyExchange(walletEcies, false); // responder
  });

  describe('3-step handshake (SYN/SYNACK/ACK)', () => {
    it('should complete full key exchange', () => {
      const keysExchangedDapp = vi.fn();
      const keysExchangedWallet = vi.fn();
      dappKex.on('keys_exchanged', keysExchangedDapp);
      walletKex.on('keys_exchanged', keysExchangedWallet);

      // Step 1: dApp creates SYN
      const syn = dappKex.createSYN();
      expect(syn).toEqual({
        type: KeyExchangeMessageType.SYN,
        pubkey: dappEcies.getPublicKey(),
        v: PROTOCOL_VERSION,
      });

      // Step 2: Wallet processes SYN, returns SYNACK
      const synack = walletKex.onMessage(syn as any);
      expect(synack).toEqual({
        type: KeyExchangeMessageType.SYNACK,
        pubkey: walletEcies.getPublicKey(),
        v: PROTOCOL_VERSION,
      });

      // Step 3: dApp processes SYNACK, returns ACK
      const ack = dappKex.onMessage(synack as any);
      expect(ack).toEqual({
        type: KeyExchangeMessageType.ACK,
        v: PROTOCOL_VERSION,
      });
      expect(keysExchangedDapp).toHaveBeenCalledOnce();

      // Step 4: Wallet processes ACK
      const result = walletKex.onMessage(ack as any);
      expect(result).toBeNull(); // No response needed
      expect(keysExchangedWallet).toHaveBeenCalledOnce();

      // Both sides should now have keys exchanged
      expect(dappKex.areKeysExchanged()).toBe(true);
      expect(walletKex.areKeysExchanged()).toBe(true);
    });

    it('should enable encrypted communication after exchange', () => {
      // Complete handshake
      const syn = dappKex.createSYN();
      const synack = walletKex.onMessage(syn as any);
      const ack = dappKex.onMessage(synack as any);
      walletKex.onMessage(ack as any);

      // dApp encrypts for wallet
      const message = JSON.stringify({ method: 'zond_getBalance' });
      const encrypted = dappKex.encryptMessage(message);
      const decrypted = walletKex.decryptMessage(encrypted);
      expect(decrypted).toBe(message);

      // Wallet encrypts for dApp
      const response = JSON.stringify({ result: '0x100' });
      const encryptedResponse = walletKex.encryptMessage(response);
      const decryptedResponse = dappKex.decryptMessage(encryptedResponse);
      expect(decryptedResponse).toBe(response);
    });

    it('should not emit keys_exchanged multiple times on duplicate SYNACK', () => {
      const keysExchangedDapp = vi.fn();
      dappKex.on('keys_exchanged', keysExchangedDapp);

      const syn = dappKex.createSYN();
      const synack = walletKex.onMessage(syn as any);
      dappKex.onMessage(synack as any);
      dappKex.onMessage(synack as any); // duplicate SYNACK

      expect(keysExchangedDapp).toHaveBeenCalledOnce();
    });

    it('should not emit keys_exchanged multiple times on duplicate ACK', () => {
      const keysExchangedWallet = vi.fn();
      walletKex.on('keys_exchanged', keysExchangedWallet);

      const syn = dappKex.createSYN();
      const synack = walletKex.onMessage(syn as any);
      const ack = dappKex.onMessage(synack as any);
      walletKex.onMessage(ack as any);
      walletKex.onMessage(ack as any); // duplicate ACK

      expect(keysExchangedWallet).toHaveBeenCalledOnce();
    });
  });

  describe('step_change events', () => {
    it('should emit step_change for each phase', () => {
      const dappSteps: KeyExchangeMessageType[] = [];
      const walletSteps: KeyExchangeMessageType[] = [];

      dappKex.on('step_change', (step) => dappSteps.push(step));
      walletKex.on('step_change', (step) => walletSteps.push(step));

      const syn = dappKex.createSYN();
      const synack = walletKex.onMessage(syn as any);
      dappKex.onMessage(synack as any);

      expect(dappSteps).toEqual([
        KeyExchangeMessageType.SYN,
        KeyExchangeMessageType.ACK,
      ]);
      expect(walletSteps).toEqual([KeyExchangeMessageType.SYNACK]);
    });
  });

  describe('role enforcement', () => {
    it('should ignore SYN on originator side', () => {
      const result = dappKex.onMessage({
        type: KeyExchangeMessageType.SYN,
        pubkey: 'fake',
      });
      expect(result).toBeNull();
    });

    it('should ignore SYNACK on non-originator side', () => {
      const result = walletKex.onMessage({
        type: KeyExchangeMessageType.SYNACK,
        pubkey: 'fake',
      });
      expect(result).toBeNull();
    });

    it('should ignore ACK on originator side', () => {
      const result = dappKex.onMessage({
        type: KeyExchangeMessageType.ACK,
      });
      expect(result).toBeNull();
    });
  });

  describe('state management', () => {
    it('should start with keys not exchanged', () => {
      expect(dappKex.areKeysExchanged()).toBe(false);
      expect(dappKex.getOtherPublicKey()).toBeNull();
    });

    it('should start at SYN step', () => {
      expect(dappKex.getCurrentStep()).toBe(KeyExchangeMessageType.SYN);
    });

    it('should store other public key after handshake', () => {
      const syn = dappKex.createSYN();
      const synack = walletKex.onMessage(syn as any);
      dappKex.onMessage(synack as any);

      expect(dappKex.getOtherPublicKey()).toBe(walletEcies.getPublicKey());
      expect(walletKex.getOtherPublicKey()).toBe(dappEcies.getPublicKey());
    });
  });

  describe('reset', () => {
    it('should reset state for a fresh handshake', () => {
      // Complete first handshake
      const syn = dappKex.createSYN();
      const synack = walletKex.onMessage(syn as any);
      const ack = dappKex.onMessage(synack as any);
      walletKex.onMessage(ack as any);

      expect(dappKex.areKeysExchanged()).toBe(true);

      // Reset
      dappKex.reset();
      expect(dappKex.areKeysExchanged()).toBe(false);
      expect(dappKex.getOtherPublicKey()).toBeNull();
      expect(dappKex.getCurrentStep()).toBe(KeyExchangeMessageType.SYN);
    });
  });

  describe('session restoration', () => {
    it('should restore with existing other public key', () => {
      const restored = new KeyExchange(
        dappEcies,
        true,
        walletEcies.getPublicKey()
      );

      expect(restored.areKeysExchanged()).toBe(true);
      expect(restored.getOtherPublicKey()).toBe(walletEcies.getPublicKey());
    });

    it('should encrypt/decrypt after restoration', () => {
      const restoredDapp = new KeyExchange(
        dappEcies,
        true,
        walletEcies.getPublicKey()
      );
      const restoredWallet = new KeyExchange(
        walletEcies,
        false,
        dappEcies.getPublicKey()
      );

      const msg = 'restored session message';
      const encrypted = restoredDapp.encryptMessage(msg);
      expect(restoredWallet.decryptMessage(encrypted)).toBe(msg);
    });
  });

  describe('error cases', () => {
    it('should throw when encrypting without key exchange', () => {
      expect(() => dappKex.encryptMessage('test')).toThrow(
        'Cannot encrypt: key exchange not complete'
      );
    });

    it('should handle unknown message type gracefully', () => {
      const result = dappKex.onMessage({
        type: 'unknown_type' as KeyExchangeMessageType,
      });
      expect(result).toBeNull();
    });
  });
});
