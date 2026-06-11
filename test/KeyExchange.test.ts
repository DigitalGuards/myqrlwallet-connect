import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KeyExchange } from '../src/KeyExchange.js';
import { KeyExchangeMessageType } from '../src/types.js';
import { PROTOCOL_VERSION } from '../src/config.js';

const CID = new Uint8Array(16).map((_, i) => i + 1);

describe('KeyExchange v2', () => {
  let dapp: KeyExchange;
  let wallet: KeyExchange;

  beforeEach(() => {
    dapp = new KeyExchange(true);
    wallet = new KeyExchange(false);
  });

  describe('handshake', () => {
    it('completes the SYNACK/ACK flow end-to-end', async () => {
      const dappKx = vi.fn();
      const walletKx = vi.fn();
      dapp.on('keys_exchanged', dappKx);
      wallet.on('keys_exchanged', walletKx);

      const pk = dapp.initiate();
      expect(pk.length).toBe(1184);

      const synack = await wallet.receiveQR(CID, pk);
      expect(synack.type).toBe(KeyExchangeMessageType.SYNACK);
      expect(synack.v).toBe(PROTOCOL_VERSION);
      expect(typeof synack.ct).toBe('string');
      expect(typeof synack.c0).toBe('string');

      const ack = await dapp.onSynAck(CID, synack);
      expect(ack).not.toBeNull();
      expect(ack!.type).toBe(KeyExchangeMessageType.ACK);
      expect(ack!.v).toBe(PROTOCOL_VERSION);
      expect(dappKx).toHaveBeenCalledOnce();

      await wallet.onAck(ack!);
      expect(walletKx).toHaveBeenCalledOnce();

      expect(dapp.areKeysExchanged()).toBe(true);
      expect(wallet.areKeysExchanged()).toBe(true);
    });

    it('is bidirectionally encrypted after handshake', async () => {
      const pk = dapp.initiate();
      const synack = await wallet.receiveQR(CID, pk);
      const ack = await dapp.onSynAck(CID, synack);
      await wallet.onAck(ack!);

      const req = JSON.stringify({ method: 'qrl_chainId' });
      const encReq = await dapp.encryptMessage(req);
      expect(await wallet.decryptMessage(encReq)).toBe(req);

      const resp = JSON.stringify({ result: '0x0' });
      const encResp = await wallet.encryptMessage(resp);
      expect(await dapp.decryptMessage(encResp)).toBe(resp);
    });

    it('assigns distinct nonces to concurrent encrypts (no AES-GCM nonce reuse)', async () => {
      const pk = dapp.initiate();
      const synack = await wallet.receiveQR(CID, pk);
      const ack = await dapp.onSynAck(CID, synack);
      await wallet.onAck(ack!);

      // Fire several encrypts WITHOUT awaiting between them. Before the
      // synchronous seq reservation, all of these read the same sendSeq and
      // sealed under the same nonce.
      const plains = ['m1', 'm2', 'm3', 'm4'];
      const cts = await Promise.all(plains.map((m) => dapp.encryptMessage(m)));

      // All ciphertexts decrypt, in order, on the wallet side: each consumed
      // a unique contiguous seq.
      for (let i = 0; i < plains.length; i++) {
        expect(await wallet.decryptMessage(cts[i]!)).toBe(plains[i]);
      }
      expect(dapp.getSession()!.sendSeq).toBe(1 + plains.length);
    });

    it('answers a retransmitted SYNACK with the cached ACK (lost-ACK recovery)', async () => {
      const pk = dapp.initiate();
      const synack = await wallet.receiveQR(CID, pk);

      // dApp completes its side; pretend the wallet never received this ACK
      // (its socket flapped right after sending SYNACK).
      const lostAck = await dapp.onSynAck(CID, synack);
      expect(lostAck).not.toBeNull();
      expect(wallet.areKeysExchanged()).toBe(false);

      // Wallet retransmits the identical SYNACK on rejoin. The dApp ignores
      // it as a duplicate but exposes the cached ACK for the manager to
      // re-send.
      const dup = await dapp.onSynAck(CID, synack);
      expect(dup).toBeNull();
      const cached = dapp.getLastAck();
      expect(cached).toEqual(lostAck);

      // The re-sent cached ACK finalizes the wallet side.
      await wallet.onAck(cached!);
      expect(wallet.areKeysExchanged()).toBe(true);
    });

    it('ignores duplicate SYNACK after handshake', async () => {
      const dappKx = vi.fn();
      dapp.on('keys_exchanged', dappKx);

      const pk = dapp.initiate();
      const synack = await wallet.receiveQR(CID, pk);
      const ackA = await dapp.onSynAck(CID, synack);
      const ackB = await dapp.onSynAck(CID, synack);
      expect(ackA).not.toBeNull();
      expect(ackB).toBeNull();
      expect(dappKx).toHaveBeenCalledOnce();
    });

    it('ignores duplicate ACK after handshake', async () => {
      const walletKx = vi.fn();
      wallet.on('keys_exchanged', walletKx);

      const pk = dapp.initiate();
      const synack = await wallet.receiveQR(CID, pk);
      const ack = await dapp.onSynAck(CID, synack);
      await wallet.onAck(ack!);
      await wallet.onAck(ack!);
      expect(walletKx).toHaveBeenCalledOnce();
    });

    it('rejects SYNACK with a wrong cid (AEAD tag fail via transcript binding)', async () => {
      const pk = dapp.initiate();
      const synack = await wallet.receiveQR(CID, pk);
      const wrongCid = new Uint8Array(16);
      await expect(dapp.onSynAck(wrongCid, synack)).rejects.toThrow();
    });

    it('rejects SYNACK with tampered ct (implicit rejection + AEAD tag fail)', async () => {
      const pk = dapp.initiate();
      const synack = await wallet.receiveQR(CID, pk);
      // Decode base64, flip a byte in ct, re-encode, and expect tag fail
      const ctBytes = Uint8Array.from(atob(synack.ct), (c) => c.charCodeAt(0));
      ctBytes[0] ^= 1;
      const mutated = btoa(String.fromCharCode(...ctBytes));
      await expect(dapp.onSynAck(CID, { ...synack, ct: mutated })).rejects.toThrow();
    });
  });

  describe('role enforcement', () => {
    it('responder cannot initiate', () => {
      expect(() => wallet.initiate()).toThrow();
    });

    it('originator cannot consume a QR', async () => {
      await expect(dapp.receiveQR(CID, new Uint8Array(1184))).rejects.toThrow();
    });
  });

  describe('state', () => {
    it('starts with keys not exchanged and step SYN', () => {
      expect(dapp.areKeysExchanged()).toBe(false);
      expect(dapp.getCurrentStep()).toBe(KeyExchangeMessageType.SYN);
    });

    it('emits step_change through the handshake', async () => {
      const dappSteps: KeyExchangeMessageType[] = [];
      const walletSteps: KeyExchangeMessageType[] = [];
      dapp.on('step_change', (s) => dappSteps.push(s));
      wallet.on('step_change', (s) => walletSteps.push(s));

      const pk = dapp.initiate();
      const synack = await wallet.receiveQR(CID, pk);
      await dapp.onSynAck(CID, synack);

      expect(dappSteps).toEqual([KeyExchangeMessageType.SYN, KeyExchangeMessageType.ACK]);
      expect(walletSteps).toEqual([KeyExchangeMessageType.SYNACK]);
    });
  });

  describe('session persistence', () => {
    it('exports and reimports a working session', async () => {
      const pk = dapp.initiate();
      const synack = await wallet.receiveQR(CID, pk);
      const ack = await dapp.onSynAck(CID, synack);
      await wallet.onAck(ack!);

      // Send once so seq counters diverge from the initial value.
      const m1 = await dapp.encryptMessage('{"m":1}');
      expect(await wallet.decryptMessage(m1)).toBe('{"m":1}');

      const persistedDapp = await dapp.exportPersisted();
      const persistedWallet = await wallet.exportPersisted();
      expect(persistedDapp).not.toBeNull();
      expect(persistedWallet).not.toBeNull();

      const restoredDapp = new KeyExchange(
        true,
        await KeyExchange.sessionFromPersisted(persistedDapp!)
      );
      const restoredWallet = new KeyExchange(
        false,
        await KeyExchange.sessionFromPersisted(persistedWallet!)
      );

      const m2 = await restoredDapp.encryptMessage('{"m":2}');
      expect(await restoredWallet.decryptMessage(m2)).toBe('{"m":2}');
      const m3 = await restoredWallet.encryptMessage('{"r":3}');
      expect(await restoredDapp.decryptMessage(m3)).toBe('{"r":3}');
    });
  });

  describe('reset', () => {
    it('wipes session state', async () => {
      const pk = dapp.initiate();
      const synack = await wallet.receiveQR(CID, pk);
      const ack = await dapp.onSynAck(CID, synack);
      await wallet.onAck(ack!);

      dapp.reset();
      expect(dapp.areKeysExchanged()).toBe(false);
      expect(dapp.getCurrentStep()).toBe(KeyExchangeMessageType.SYN);
      await expect(dapp.encryptMessage('x')).rejects.toThrow();
    });
  });
});
