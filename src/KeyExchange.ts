/**
 * Post-quantum handshake (v2).
 *
 * Flow:
 *    dApp                                  relay                 wallet
 *    ────────────────────────────────────────────────────────────────────
 *    initiate() → (pk, sk)
 *    QR(cid, pk) rendered                                        scan QR
 *                                                                receiveQR(cid, pk)
 *                                                                → SYNACK{ct, c0}
 *                                            ◄── SYNACK ─────── send
 *    onSynAck(cid, SYNACK)
 *    → ACK{c1}
 *    send ACK ──►                            ──► ack            onAck(ACK)
 *
 * Data phase: encryptMessage / decryptMessage use direction-tagged counter
 * nonces and AAD = H_tx || seq to bind every ciphertext to the transcript.
 */

import EventEmitter from 'eventemitter3';
import {
  type Keypair,
  DIR_DAPP_TX,
  DIR_WALLET_TX,
  ML_KEM_768_CT_LEN,
  constantTimeEquals,
  deriveAeadKey,
  exportRawAeadKey,
  fromBase64,
  importRawAeadKey,
  kemDecaps,
  kemEncaps,
  kemKeygen,
  open,
  seal,
  toBase64,
  transcriptHash,
  zeroize,
} from './PQCrypto.js';
import { PROTOCOL_VERSION } from './config.js';
import { KeyExchangeMessageType } from './types.js';
import { log, warn } from './utils/logger.js';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const HELLO_WALLET = textEncoder.encode('hello/wallet/v1');
const HELLO_DAPP = textEncoder.encode('hello/dapp/v1');

export interface Session {
  cid: Uint8Array;
  key: CryptoKey;
  htx: Uint8Array;
  sendDir: Uint8Array;
  recvDir: Uint8Array;
  sendSeq: number;
  recvSeq: number;
}

/** Wire-safe persisted form for localStorage. */
export interface PersistedSession {
  cid: string;
  kAeadRaw: string;
  htx: string;
  sendDir: string;
  recvDir: string;
  sendSeq: number;
  recvSeq: number;
}

export interface SynAckMessage {
  type: KeyExchangeMessageType.SYNACK;
  ct: string;
  c0: string;
  v: number;
}

export interface AckMessage {
  type: KeyExchangeMessageType.ACK;
  c1: string;
  v: number;
}

export type KeyExchangeMessage = SynAckMessage | AckMessage;

interface KeyExchangeEvents {
  keys_exchanged: () => void;
  step_change: (step: KeyExchangeMessageType) => void;
}

export class KeyExchange extends EventEmitter<KeyExchangeEvents> {
  private isOriginator: boolean;
  private keypair: Keypair | null = null;
  private session: Session | null = null;
  private step: KeyExchangeMessageType = KeyExchangeMessageType.SYN;
  private awaitingSynAck = false;
  private awaitingAck = false;
  private keysExchanged = false;

  constructor(isOriginator: boolean, restored?: Session) {
    super();
    this.isOriginator = isOriginator;
    if (restored) {
      this.session = restored;
      this.keysExchanged = true;
      this.step = KeyExchangeMessageType.ACK;
      log('KeyExchange', 'Hydrated from persisted session');
    }
  }

  /**
   * Originator (dApp) side: begin a fresh handshake by generating an
   * ephemeral ML-KEM-768 keypair. Returns pk to embed in the QR URI.
   */
  initiate(): Uint8Array {
    if (!this.isOriginator) {
      throw new Error('KeyExchange: responder cannot initiate');
    }
    this.resetInternal(false);
    this.keypair = kemKeygen();
    this.step = KeyExchangeMessageType.SYN;
    this.awaitingSynAck = true;
    this.emit('step_change', this.step);
    return this.keypair.pk;
  }

  /**
   * Originator: handle a SYNACK received over the relay.
   * Returns an ACK wire message to send, or null if the SYNACK was a
   * duplicate (handshake already complete).
   */
  async onSynAck(cid: Uint8Array, msg: SynAckMessage): Promise<AckMessage | null> {
    if (!this.isOriginator) {
      warn('KeyExchange', 'Responder received SYNACK - ignoring');
      return null;
    }
    if (!this.awaitingSynAck || !this.keypair) {
      return null;
    }
    this.awaitingSynAck = false;

    const ct = fromBase64(msg.ct);
    const c0 = fromBase64(msg.c0);
    if (ct.length !== ML_KEM_768_CT_LEN) {
      throw new Error(`KeyExchange: bad ct length ${ct.length}`);
    }

    const ss = kemDecaps(this.keypair.sk, ct);
    const htx = await transcriptHash(cid, this.keypair.pk, ct);
    const key = await deriveAeadKey(ss, htx);

    let hello: Uint8Array;
    try {
      hello = await open(key, DIR_WALLET_TX, 0, htx, c0);
    } catch {
      throw new Error(
        'KeyExchange: wallet hello AEAD tag failed (tampered SYNACK, wrong QR, or protocol mismatch)'
      );
    }
    if (!constantTimeEquals(hello, HELLO_WALLET)) {
      throw new Error('KeyExchange: wallet hello mismatch');
    }

    zeroize(ss);
    zeroize(this.keypair.sk);
    this.keypair = null;

    const c1 = await seal(key, DIR_DAPP_TX, 0, htx, HELLO_DAPP);

    this.session = {
      cid,
      key,
      htx,
      sendDir: DIR_DAPP_TX,
      recvDir: DIR_WALLET_TX,
      sendSeq: 1,
      recvSeq: 1,
    };
    this.keysExchanged = true;
    this.step = KeyExchangeMessageType.ACK;
    this.emit('keys_exchanged');
    this.emit('step_change', this.step);

    return {
      type: KeyExchangeMessageType.ACK,
      c1: toBase64(c1),
      v: PROTOCOL_VERSION,
    };
  }

  /**
   * Responder (wallet) side: begin handshake from a scanned QR.
   * Returns the SYNACK wire message to emit on the relay.
   */
  async receiveQR(cid: Uint8Array, pk: Uint8Array): Promise<SynAckMessage> {
    if (this.isOriginator) {
      throw new Error('KeyExchange: originator cannot consume a QR');
    }
    this.resetInternal(false);

    const { ct, ss } = kemEncaps(pk);
    const htx = await transcriptHash(cid, pk, ct);
    const key = await deriveAeadKey(ss, htx);
    const c0 = await seal(key, DIR_WALLET_TX, 0, htx, HELLO_WALLET);
    zeroize(ss);

    this.session = {
      cid,
      key,
      htx,
      sendDir: DIR_WALLET_TX,
      recvDir: DIR_DAPP_TX,
      sendSeq: 1,
      recvSeq: 1,
    };
    this.awaitingAck = true;
    this.step = KeyExchangeMessageType.SYNACK;
    this.emit('step_change', this.step);

    return {
      type: KeyExchangeMessageType.SYNACK,
      ct: toBase64(ct),
      c0: toBase64(c0),
      v: PROTOCOL_VERSION,
    };
  }

  /**
   * Responder: verify an incoming ACK and finalize the session.
   * Duplicates are silently ignored (handshake is idempotent).
   */
  async onAck(msg: AckMessage): Promise<void> {
    if (this.isOriginator) {
      warn('KeyExchange', 'Originator received ACK - ignoring');
      return;
    }
    if (!this.awaitingAck) {
      return;
    }
    if (!this.session) {
      throw new Error('KeyExchange: onAck called without a session');
    }
    this.awaitingAck = false;

    const c1 = fromBase64(msg.c1);
    let hello: Uint8Array;
    try {
      hello = await open(this.session.key, DIR_DAPP_TX, 0, this.session.htx, c1);
    } catch {
      throw new Error('KeyExchange: dApp hello AEAD tag failed');
    }
    if (!constantTimeEquals(hello, HELLO_DAPP)) {
      throw new Error('KeyExchange: dApp hello mismatch');
    }

    this.keysExchanged = true;
    this.step = KeyExchangeMessageType.ACK;
    this.emit('keys_exchanged');
  }

  /** Encrypt a string for the counterparty. Returns base64. */
  async encryptMessage(data: string): Promise<string> {
    if (!this.session) {
      throw new Error('KeyExchange: cannot encrypt - session not established');
    }
    const pt = textEncoder.encode(data);
    const ct = await seal(
      this.session.key,
      this.session.sendDir,
      this.session.sendSeq,
      this.session.htx,
      pt
    );
    this.session.sendSeq++;
    return toBase64(ct);
  }

  /** Decrypt a base64 ciphertext from the counterparty. */
  async decryptMessage(b64: string): Promise<string> {
    if (!this.session) {
      throw new Error('KeyExchange: cannot decrypt - session not established');
    }
    const ct = fromBase64(b64);
    const pt = await open(
      this.session.key,
      this.session.recvDir,
      this.session.recvSeq,
      this.session.htx,
      ct
    );
    this.session.recvSeq++;
    return textDecoder.decode(pt);
  }

  /** Reset all state for a fresh handshake. Zeroes any live secret-key buffer. */
  reset(): void {
    this.resetInternal(true);
  }

  private resetInternal(emit: boolean): void {
    if (this.keypair) {
      zeroize(this.keypair.sk);
      this.keypair = null;
    }
    this.session = null;
    this.keysExchanged = false;
    this.awaitingSynAck = false;
    this.awaitingAck = false;
    this.step = KeyExchangeMessageType.SYN;
    if (emit) this.emit('step_change', this.step);
  }

  areKeysExchanged(): boolean {
    return this.keysExchanged;
  }

  getSession(): Session | null {
    return this.session;
  }

  getCurrentStep(): KeyExchangeMessageType {
    return this.step;
  }

  /** Export the current session as a JSON-safe persisted record. */
  async exportPersisted(): Promise<PersistedSession | null> {
    if (!this.session) return null;
    return {
      cid: toBase64(this.session.cid),
      kAeadRaw: toBase64(await exportRawAeadKey(this.session.key)),
      htx: toBase64(this.session.htx),
      sendDir: toBase64(this.session.sendDir),
      recvDir: toBase64(this.session.recvDir),
      sendSeq: this.session.sendSeq,
      recvSeq: this.session.recvSeq,
    };
  }

  /** Rehydrate a Session from its persisted form. */
  static async sessionFromPersisted(p: PersistedSession): Promise<Session> {
    const key = await importRawAeadKey(fromBase64(p.kAeadRaw));
    return {
      cid: fromBase64(p.cid),
      key,
      htx: fromBase64(p.htx),
      sendDir: fromBase64(p.sendDir),
      recvDir: fromBase64(p.recvDir),
      sendSeq: p.sendSeq,
      recvSeq: p.recvSeq,
    };
  }
}
