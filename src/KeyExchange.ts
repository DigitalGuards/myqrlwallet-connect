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

function snapshotSession(session: Session): Session {
  return {
    ...session,
    cid: session.cid.slice(),
    htx: session.htx.slice(),
    sendDir: session.sendDir.slice(),
    recvDir: session.recvDir.slice(),
  };
}

export class KeyExchange extends EventEmitter<KeyExchangeEvents> {
  private isOriginator: boolean;
  private keypair: Keypair | null = null;
  private session: Session | null = null;
  private step: KeyExchangeMessageType = KeyExchangeMessageType.SYN;
  private awaitingSynAck = false;
  private awaitingAck = false;
  private keysExchanged = false;
  private stateGeneration = 0;
  // The ACK we produced for the current handshake. A wallet that lost its
  // transport right after sending SYNACK re-sends the identical SYNACK on
  // rejoin; we answer with this cached ACK so the handshake converges
  // instead of stalling (onSynAck ignores duplicates and would otherwise
  // never reply). Cleared on reset; not persisted (a reloaded dApp has a
  // completed session and the wallet is no longer awaiting an ACK).
  private lastAck: AckMessage | null = null;

  constructor(isOriginator: boolean, restored?: Session) {
    super();
    this.isOriginator = isOriginator;
    if (restored) {
      this.session = snapshotSession(restored);
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
    return this.keypair.pk.slice();
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
    const stableCid = cid.slice();
    const keypair = this.keypair;
    const generation = this.stateGeneration;
    let ss: Uint8Array | null = null;
    try {
      const ct = fromBase64(msg.ct);
      const c0 = fromBase64(msg.c0);
      if (ct.length !== ML_KEM_768_CT_LEN) {
        throw new Error(`KeyExchange: bad ct length ${ct.length}`);
      }

      ss = kemDecaps(keypair.sk, ct);
      const htx = await transcriptHash(stableCid, keypair.pk, ct);
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

      if (this.stateGeneration !== generation || this.keypair !== keypair) {
        throw new Error('KeyExchange: handshake generation changed');
      }

      const c1 = await seal(key, DIR_DAPP_TX, 0, htx, HELLO_DAPP);

      if (this.stateGeneration !== generation || this.keypair !== keypair) {
        throw new Error('KeyExchange: handshake generation changed');
      }

      zeroize(keypair.sk);
      if (this.keypair === keypair) this.keypair = null;
      this.session = {
        cid: stableCid,
        key,
        htx,
        sendDir: DIR_DAPP_TX.slice(),
        recvDir: DIR_WALLET_TX.slice(),
        sendSeq: 1,
        recvSeq: 1,
      };
      this.keysExchanged = true;
      this.step = KeyExchangeMessageType.ACK;
      this.emit('keys_exchanged');
      this.emit('step_change', this.step);

      const ack: AckMessage = {
        type: KeyExchangeMessageType.ACK,
        c1: toBase64(c1),
        v: PROTOCOL_VERSION,
      };
      this.lastAck = { ...ack };
      return ack;
    } catch (error) {
      // A consumed handshake frame cannot be retried safely. Drop all derived
      // state and wipe the KEM secret so a bad first SYNACK cannot strand a
      // half-live pairing or retain secret material until garbage collection.
      if (this.stateGeneration === generation) this.resetInternal(false);
      throw error;
    } finally {
      if (ss) zeroize(ss);
    }
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
    const generation = this.stateGeneration;
    const stableCid = cid.slice();
    const stablePk = pk.slice();

    let ss: Uint8Array | null = null;
    try {
      const encapsulated = kemEncaps(stablePk);
      const { ct } = encapsulated;
      ss = encapsulated.ss;
      const htx = await transcriptHash(stableCid, stablePk, ct);
      const key = await deriveAeadKey(ss, htx);
      const c0 = await seal(key, DIR_WALLET_TX, 0, htx, HELLO_WALLET);

      if (this.stateGeneration !== generation) {
        throw new Error('KeyExchange: handshake generation changed');
      }

      this.session = {
        cid: stableCid,
        key,
        htx,
        sendDir: DIR_WALLET_TX.slice(),
        recvDir: DIR_DAPP_TX.slice(),
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
    } catch (error) {
      if (this.stateGeneration === generation) this.resetInternal(false);
      throw error;
    } finally {
      if (ss) zeroize(ss);
    }
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
    const session = this.session;
    const generation = this.stateGeneration;

    try {
      const c1 = fromBase64(msg.c1);
      let hello: Uint8Array;
      try {
        hello = await open(session.key, DIR_DAPP_TX, 0, session.htx, c1);
      } catch {
        throw new Error('KeyExchange: dApp hello AEAD tag failed');
      }
      if (!constantTimeEquals(hello, HELLO_DAPP)) {
        throw new Error('KeyExchange: dApp hello mismatch');
      }
      if (this.stateGeneration !== generation || this.session !== session) {
        throw new Error('KeyExchange: handshake generation changed');
      }

      this.keysExchanged = true;
      this.step = KeyExchangeMessageType.ACK;
      this.emit('keys_exchanged');
    } catch (error) {
      // Symmetric fail-closed behavior: once an ACK frame has been consumed,
      // authentication failure retires the provisional session.
      if (this.stateGeneration === generation) this.resetInternal(false);
      throw error;
    }
  }

  /** Encrypt a string for the counterparty. Returns base64. */
  async encryptMessage(data: string): Promise<string> {
    const session = this.session;
    const generation = this.stateGeneration;
    if (!session) {
      throw new Error('KeyExchange: cannot encrypt - session not established');
    }
    // Reserve the sequence number SYNCHRONOUSLY, before the first await.
    // Reading it as a seal() argument and incrementing after the await opens
    // an interleaving window where two concurrent encrypts read the same seq
    // and seal two plaintexts under the same AES-GCM nonce. With the sync
    // reservation the worst concurrent case is out-of-order completion,
    // which the receiver's contiguous-seq check drops (fail closed).
    // ConnectionManager additionally serializes sends on an outbound queue
    // so ordering is preserved end-to-end.
    if (session.sendSeq >= Number.MAX_SAFE_INTEGER) {
      throw new Error('KeyExchange: send counter exhausted');
    }
    const seq = session.sendSeq++;
    const pt = textEncoder.encode(data);
    const ct = await seal(session.key, session.sendDir, seq, session.htx, pt);
    if (this.stateGeneration !== generation || this.session !== session) {
      throw new Error('KeyExchange: session changed while encrypting');
    }
    return toBase64(ct);
  }

  /** Decrypt a base64 ciphertext from the counterparty. */
  async decryptMessage(b64: string): Promise<string> {
    const session = this.session;
    const generation = this.stateGeneration;
    if (!session) {
      throw new Error('KeyExchange: cannot decrypt - session not established');
    }
    if (session.recvSeq >= Number.MAX_SAFE_INTEGER) {
      throw new Error('KeyExchange: receive counter exhausted');
    }
    const ct = fromBase64(b64);
    const pt = await open(session.key, session.recvDir, session.recvSeq, session.htx, ct);
    if (this.stateGeneration !== generation || this.session !== session) {
      throw new Error('KeyExchange: session changed while decrypting');
    }
    session.recvSeq++;
    return textDecoder.decode(pt);
  }

  /** Reset all state for a fresh handshake. Zeroes any live secret-key buffer. */
  reset(): void {
    this.resetInternal(true);
  }

  private resetInternal(emit: boolean): void {
    this.stateGeneration++;
    if (this.keypair) {
      zeroize(this.keypair.sk);
      this.keypair = null;
    }
    this.session = null;
    this.keysExchanged = false;
    this.awaitingSynAck = false;
    this.awaitingAck = false;
    this.lastAck = null;
    this.step = KeyExchangeMessageType.SYN;
    if (emit) this.emit('step_change', this.step);
  }

  areKeysExchanged(): boolean {
    return this.keysExchanged;
  }

  /** The ACK produced for the current handshake, for duplicate-SYNACK replies. */
  getLastAck(): AckMessage | null {
    return this.lastAck ? { ...this.lastAck } : null;
  }

  getSession(): Session | null {
    return this.session ? snapshotSession(this.session) : null;
  }

  getCurrentStep(): KeyExchangeMessageType {
    return this.step;
  }

  /** Export the current session as a JSON-safe persisted record. */
  async exportPersisted(): Promise<PersistedSession | null> {
    const session = this.session;
    const generation = this.stateGeneration;
    if (!session) return null;
    const kAeadRaw = await exportRawAeadKey(session.key);
    if (this.stateGeneration !== generation || this.session !== session) return null;
    return {
      cid: toBase64(session.cid),
      kAeadRaw: toBase64(kAeadRaw),
      htx: toBase64(session.htx),
      sendDir: toBase64(session.sendDir),
      recvDir: toBase64(session.recvDir),
      sendSeq: session.sendSeq,
      recvSeq: session.recvSeq,
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
