import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KeyExchange } from '../src/KeyExchange.js';
import { KeyExchangeMessageType } from '../src/types.js';
import { PAIRING_CAPABILITY_LEN, PROTOCOL_VERSION } from '../src/config.js';
import {
  DIR_WALLET_TX,
  deriveAeadKey,
  kemEncaps,
  seal,
  toBase64,
  transcriptHash,
  zeroize,
} from '../src/PQCrypto.js';

const CID = new Uint8Array(16).map((_, i) => i + 1);

describe('KeyExchange v3', () => {
  let dapp: KeyExchange;
  let wallet: KeyExchange;

  beforeEach(() => {
    dapp = new KeyExchange(true);
    wallet = new KeyExchange(false);
  });

  async function initiateSynAck() {
    const pairing = dapp.initiate();
    return wallet.receiveQR(CID, pairing.publicKey, pairing.capability);
  }

  describe('handshake', () => {
    it('completes the SYNACK/ACK flow end-to-end', async () => {
      const dappKx = vi.fn();
      const walletKx = vi.fn();
      dapp.on('keys_exchanged', dappKx);
      wallet.on('keys_exchanged', walletKx);

      const pairing = dapp.initiate();
      expect(pairing.publicKey.length).toBe(1184);
      expect(pairing.capability.length).toBe(PAIRING_CAPABILITY_LEN);

      const synack = await wallet.receiveQR(CID, pairing.publicKey, pairing.capability);
      expect(synack.type).toBe(KeyExchangeMessageType.SYNACK);
      expect(synack.v).toBe(PROTOCOL_VERSION);
      expect(typeof synack.ct).toBe('string');
      expect(typeof synack.c0).toBe('string');

      const ack = await dapp.onSynAck(CID, synack);
      expect(ack).not.toBeNull();
      expect(ack!.type).toBe(KeyExchangeMessageType.ACK);
      expect(ack!.v).toBe(PROTOCOL_VERSION);
      expect(dapp.areKeysExchanged()).toBe(false);
      expect(dappKx).not.toHaveBeenCalled();
      expect(await dapp.exportPersisted()).toBeNull();

      dapp.confirmOriginatorAckDelivered();
      expect(dappKx).toHaveBeenCalledOnce();

      await wallet.onAck(ack!);
      expect(walletKx).toHaveBeenCalledOnce();

      expect(dapp.areKeysExchanged()).toBe(true);
      expect(wallet.areKeysExchanged()).toBe(true);
    });

    it('snapshots the public key returned for QR generation', async () => {
      const exposed = dapp.initiate();
      const qrPk = exposed.publicKey.slice();
      const qrCapability = exposed.capability.slice();
      exposed.publicKey.fill(0);
      exposed.capability.fill(0);

      const synack = await wallet.receiveQR(CID, qrPk, qrCapability);
      const ack = await dapp.onSynAck(CID, synack);
      dapp.confirmOriginatorAckDelivered();
      await wallet.onAck(ack!);

      expect(dapp.areKeysExchanged()).toBe(true);
      expect(wallet.areKeysExchanged()).toBe(true);
    });

    it('is bidirectionally encrypted after handshake', async () => {
      const synack = await initiateSynAck();
      const ack = await dapp.onSynAck(CID, synack);
      dapp.confirmOriginatorAckDelivered();
      await wallet.onAck(ack!);

      const req = JSON.stringify({ method: 'qrl_chainId' });
      const encReq = await dapp.encryptMessage(req);
      expect(await wallet.decryptMessage(encReq)).toBe(req);

      const resp = JSON.stringify({ result: '0x0' });
      const encResp = await wallet.encryptMessage(resp);
      expect(await dapp.decryptMessage(encResp)).toBe(resp);
    });

    it('assigns distinct nonces to concurrent encrypts (no AES-GCM nonce reuse)', async () => {
      const synack = await initiateSynAck();
      const ack = await dapp.onSynAck(CID, synack);
      dapp.confirmOriginatorAckDelivered();
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
      const synack = await initiateSynAck();

      // dApp completes its side; pretend the wallet never received this ACK
      // (its socket flapped right after sending SYNACK).
      const lostAck = await dapp.onSynAck(CID, synack);
      expect(lostAck).not.toBeNull();
      expect(wallet.areKeysExchanged()).toBe(false);
      dapp.confirmOriginatorAckDelivered();
      lostAck!.c1 = 'mutated-by-consumer';

      // Wallet retransmits the identical SYNACK on rejoin. The dApp ignores
      // it as a duplicate but exposes the cached ACK for the manager to
      // re-send.
      const dup = await dapp.onSynAck(CID, synack);
      expect(dup).toBeNull();
      const cached = dapp.getLastAck();
      expect(cached?.c1).not.toBe('mutated-by-consumer');
      const cachedBytes = cached!.c1;
      cached!.c1 = 'second-consumer-mutation';
      expect(dapp.getLastAck()?.c1).toBe(cachedBytes);

      // The re-sent cached ACK finalizes the wallet side.
      await wallet.onAck(dapp.getLastAck()!);
      expect(wallet.areKeysExchanged()).toBe(true);
    });

    it('ignores duplicate SYNACK after handshake', async () => {
      const dappKx = vi.fn();
      dapp.on('keys_exchanged', dappKx);

      const synack = await initiateSynAck();
      const ackA = await dapp.onSynAck(CID, synack);
      dapp.confirmOriginatorAckDelivered();
      const ackB = await dapp.onSynAck(CID, synack);
      expect(ackA).not.toBeNull();
      expect(ackB).toBeNull();
      expect(dappKx).toHaveBeenCalledOnce();
    });

    it('ignores duplicate ACK after handshake', async () => {
      const walletKx = vi.fn();
      wallet.on('keys_exchanged', walletKx);

      const synack = await initiateSynAck();
      const ack = await dapp.onSynAck(CID, synack);
      await wallet.onAck(ack!);
      await wallet.onAck(ack!);
      expect(walletKx).toHaveBeenCalledOnce();
    });

    it('rejects SYNACK with a wrong cid (AEAD tag fail via transcript binding)', async () => {
      const synack = await initiateSynAck();
      const wrongCid = new Uint8Array(16);
      await expect(dapp.onSynAck(wrongCid, synack)).rejects.toThrow();
    });

    it('rejects SYNACK with tampered ct (implicit rejection + AEAD tag fail)', async () => {
      const synack = await initiateSynAck();
      // Decode base64, flip a byte in ct, re-encode, and expect tag fail
      const ctBytes = Uint8Array.from(atob(synack.ct), (c) => c.charCodeAt(0));
      ctBytes[0] ^= 1;
      const mutated = btoa(String.fromCharCode(...ctBytes));
      await expect(dapp.onSynAck(CID, { ...synack, ct: mutated })).rejects.toThrow();
      expect(dapp.areKeysExchanged()).toBe(false);
      expect(dapp.getSession()).toBeNull();
      // The consumed handshake generation is retired. A later valid frame
      // cannot revive the provisional key material.
      await expect(dapp.onSynAck(CID, synack)).resolves.toBeNull();
    });

    it('rejects a relay impersonation built without the QR capability', async () => {
      const pairing = dapp.initiate();
      const attackerCapability = pairing.capability.slice();
      attackerCapability[0] ^= 1;
      const { ct, ss } = kemEncaps(pairing.publicKey);
      try {
        const attackerHtx = await transcriptHash(
          CID,
          pairing.publicKey,
          ct,
          attackerCapability
        );
        const attackerKey = await deriveAeadKey(ss, attackerHtx, attackerCapability);
        const c0 = await seal(
          attackerKey,
          DIR_WALLET_TX,
          0,
          attackerHtx,
          new TextEncoder().encode('hello/wallet/v1')
        );

        await expect(
          dapp.onSynAck(CID, {
            type: KeyExchangeMessageType.SYNACK,
            ct: toBase64(ct),
            c0: toBase64(c0),
            v: PROTOCOL_VERSION,
          })
        ).rejects.toThrow(/AEAD tag failed/);
      } finally {
        zeroize(ss);
        zeroize(attackerCapability);
        zeroize(pairing.capability);
      }
      expect(dapp.areKeysExchanged()).toBe(false);
      expect(dapp.getSession()).toBeNull();
    });

    it('rejects explicit pre-v3 SYNACK and ACK frames', async () => {
      const synack = await initiateSynAck();
      await expect(dapp.onSynAck(CID, { ...synack, v: 2 })).rejects.toThrow(/protocol v3/);
      expect(dapp.getSession()).toBeNull();

      const validSynAck = await initiateSynAck();
      const ack = await dapp.onSynAck(CID, validSynAck);
      dapp.confirmOriginatorAckDelivered();
      await expect(wallet.onAck({ ...ack!, v: 2 })).rejects.toThrow(/protocol v3/);
      expect(wallet.getSession()).toBeNull();
    });

    it('rejects oversized ciphertext and wrong-width wallet hello before unbounded decoding', async () => {
      const pairing = dapp.initiate();
      const synack = await wallet.receiveQR(CID, pairing.publicKey, pairing.capability);
      await expect(dapp.onSynAck(CID, { ...synack, ct: `${synack.ct}AAAA` })).rejects.toThrow(
        /1088 bytes/
      );
      expect(dapp.getSession()).toBeNull();

      const nextPairing = dapp.initiate();
      const nextSynack = await wallet.receiveQR(
        CID,
        nextPairing.publicKey,
        nextPairing.capability
      );
      const wrongDecodedWidth = `${nextSynack.c0.slice(0, -2)}AB`;
      await expect(
        dapp.onSynAck(CID, { ...nextSynack, c0: wrongDecodedWidth })
      ).rejects.toThrow(/31 bytes/);
      expect(dapp.getSession()).toBeNull();
    });

    it('retires the responder session after a tampered ACK', async () => {
      const synack = await initiateSynAck();
      const ack = await dapp.onSynAck(CID, synack);
      dapp.confirmOriginatorAckDelivered();
      const c1Bytes = Uint8Array.from(atob(ack!.c1), (c) => c.charCodeAt(0));
      c1Bytes[0] ^= 1;
      const tampered = { ...ack!, c1: btoa(String.fromCharCode(...c1Bytes)) };

      await expect(wallet.onAck(tampered)).rejects.toThrow();
      expect(wallet.areKeysExchanged()).toBe(false);
      expect(wallet.getSession()).toBeNull();
      await expect(wallet.onAck(ack!)).resolves.toBeUndefined();
      expect(wallet.areKeysExchanged()).toBe(false);
    });
  });

  describe('role enforcement', () => {
    it('responder cannot initiate', () => {
      expect(() => wallet.initiate()).toThrow();
    });

    it('originator cannot consume a QR', async () => {
      await expect(
        dapp.receiveQR(CID, new Uint8Array(1184), new Uint8Array(PAIRING_CAPABILITY_LEN))
      ).rejects.toThrow();
    });

    it('responder cannot confirm originator ACK delivery', () => {
      expect(() => { wallet.confirmOriginatorAckDelivered(); }).toThrow(/responder/);
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

      const synack = await initiateSynAck();
      await dapp.onSynAck(CID, synack);
      dapp.confirmOriginatorAckDelivered();

      expect(dappSteps).toEqual([KeyExchangeMessageType.SYN, KeyExchangeMessageType.ACK]);
      expect(walletSteps).toEqual([KeyExchangeMessageType.SYNACK]);
    });
  });

  describe('session persistence', () => {
    it('exports and reimports a working session', async () => {
      const synack = await initiateSynAck();
      const ack = await dapp.onSynAck(CID, synack);
      dapp.confirmOriginatorAckDelivered();
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

    it('rejects pre-v3 persisted sessions at the low-level hydration boundary', async () => {
      const synack = await initiateSynAck();
      const ack = await dapp.onSynAck(CID, synack);
      dapp.confirmOriginatorAckDelivered();
      await wallet.onAck(ack!);
      const persisted = (await dapp.exportPersisted())!;
      persisted.protocolVersion = 2 as 3;
      await expect(KeyExchange.sessionFromPersisted(persisted)).rejects.toThrow(/pre-v3/);
    });

    it('rejects persisted key material whose decoded fields have the wrong width', async () => {
      const synack = await initiateSynAck();
      const ack = await dapp.onSynAck(CID, synack);
      dapp.confirmOriginatorAckDelivered();
      await wallet.onAck(ack!);
      const persisted = (await dapp.exportPersisted())!;

      await expect(
        KeyExchange.sessionFromPersisted({ ...persisted, cid: 'AA==' })
      ).rejects.toThrow(/channel id/);
      await expect(
        KeyExchange.sessionFromPersisted({ ...persisted, kAeadRaw: 'AA==' })
      ).rejects.toThrow(/AEAD key/);
      await expect(
        KeyExchange.sessionFromPersisted({ ...persisted, htx: 'AA==' })
      ).rejects.toThrow(/transcript hash/);
      await expect(
        KeyExchange.sessionFromPersisted({ ...persisted, sendDir: 'AA==' })
      ).rejects.toThrow(/send direction/);
      await expect(
        KeyExchange.sessionFromPersisted({ ...persisted, recvDir: 'AA==' })
      ).rejects.toThrow(/receive direction/);
    });

    it('rejects exhausted send and receive counters before cryptographic use', async () => {
      const synack = await initiateSynAck();
      const ack = await dapp.onSynAck(CID, synack);
      dapp.confirmOriginatorAckDelivered();
      await wallet.onAck(ack!);

      const dappPersisted = (await dapp.exportPersisted())!;
      dappPersisted.sendSeq = Number.MAX_SAFE_INTEGER;
      const exhaustedSender = new KeyExchange(
        true,
        await KeyExchange.sessionFromPersisted(dappPersisted)
      );
      await expect(exhaustedSender.encryptMessage('must not seal')).rejects.toThrow(
        'send counter exhausted'
      );

      const walletPersisted = (await wallet.exportPersisted())!;
      walletPersisted.recvSeq = Number.MAX_SAFE_INTEGER;
      const exhaustedReceiver = new KeyExchange(
        false,
        await KeyExchange.sessionFromPersisted(walletPersisted)
      );
      await expect(exhaustedReceiver.decryptMessage('AA==')).rejects.toThrow(
        'receive counter exhausted'
      );
    });

    it('does not expose mutable references to live session counters or AAD', async () => {
      const synack = await initiateSynAck();
      const ack = await dapp.onSynAck(CID, synack);
      dapp.confirmOriginatorAckDelivered();
      await wallet.onAck(ack!);

      const exposed = dapp.getSession()!;
      exposed.sendSeq = 0;
      exposed.htx.fill(0);

      const ciphertext = await dapp.encryptMessage('still-bound');
      await expect(wallet.decryptMessage(ciphertext)).resolves.toBe('still-bound');
      expect(dapp.getSession()!.sendSeq).toBe(2);
    });
  });

  describe('reset', () => {
    it('wipes session state', async () => {
      const synack = await initiateSynAck();
      const ack = await dapp.onSynAck(CID, synack);
      await wallet.onAck(ack!);

      dapp.reset();
      expect(dapp.areKeysExchanged()).toBe(false);
      expect(dapp.getCurrentStep()).toBe(KeyExchangeMessageType.SYN);
      await expect(dapp.encryptMessage('x')).rejects.toThrow();
    });
  });
});
