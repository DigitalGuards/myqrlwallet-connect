/**
 * E2E Test: QRL Connect 4.0 + protocol-v3 post-quantum handshake + JSON-RPC round-trip.
 *
 * Exercises the real built SDK (dist/index.mjs) as the dApp, and a minimal
 * wallet simulator built on top of the SDK's KeyExchange (isOriginator=false)
 * against a real Socket.IO relay.
 *
 * Run: node test-e2e.js
 */

import { createServer } from 'http';
import { io as ioClient } from 'socket.io-client';
// The backend is TypeScript now: the relay must be imported from its built
// output (run `npm run build` in ../myqrlwallet-backend if dist/ is missing).
import { createRelayServer } from '../myqrlwallet-backend/dist/relay/relayServer.js';
import {
  QRLConnect,
  ConnectionStatus,
  KeyExchange,
  parseConnectionURI,
  computeFingerprint,
  fingerprintEquals,
  KeyExchangeMessageType,
  MessageType,
  PROTOCOL_VERSION,
  bytesToHex,
  computeMessageDigest,
  computeTypedDataDigest,
  hexToBytes,
  SCHEME_TAG_MSG,
  SCHEME_TAG_TYPED,
  SCHEME_VERSION_MSG,
  SCHEME_VERSION_TYPED,
  verifyMessageForSigner,
  verifyTypedDataForSigner,
} from './dist/index.mjs';
import * as mldsa from '@theqrl/mldsa87';
import { newWalletFromExtendedSeed } from '@theqrl/wallet.js';

function fromBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const TEST_PORT = 3001;
const RELAY_URL = `http://localhost:${TEST_PORT}`;
const RELAY_PATH = '/relay';

// Current Q + 40 hex address derived from descriptor || ML-DSA public key.
const WALLET_ADDRESS = 'Q919e248e9bc56e8d1f255841d6c92d9bd892e33a';
const TEST_TX_HASH =
  '0x3e306b5a5a37532e1734503f7d2427a86f2c992fbe471f5be403b9f734e661c5';

/**
 * Stable extended seed used only by the e2e signing tests. Same shape as a
 * real wallet seed (descriptor + 48 random bytes, hex-encoded). Never used
 * in production: purely a deterministic test vector.
 */
const E2E_HEX_SEED =
  '0x0100005bb4c0cea35e758d19a93923d014e41615e7d3d35076c9b659b880156b5c37bc3a6ccf3d3b7beaef012c4ff930fcb270';
const WALLET_DESCRIPTOR = E2E_HEX_SEED.slice(0, 8);

function signE2E(digest, ctxTag) {
  const wallet = newWalletFromExtendedSeed(E2E_HEX_SEED);
  try {
    const sig = new Uint8Array(mldsa.CryptoBytes);
    mldsa.cryptoSignSignature(sig, digest, wallet.sk, false, ctxTag);
    return { signature: sig, publicKey: new Uint8Array(wallet.pk) };
  } finally {
    wallet.zeroize();
  }
}

const TIMEOUT = setTimeout(() => {
  console.error('❌ E2E TEST TIMED OUT after 15s');
  process.exit(1);
}, 15000);

function createSocket() {
  return ioClient(RELAY_URL, {
    path: RELAY_PATH,
    transports: ['websocket'],
    reconnection: false,
  });
}

function joinChannel(socket, channelId, clientType, publicKey) {
  return new Promise((resolve, reject) => {
    const payload = { channelId, clientType };
    if (publicKey) payload.publicKey = publicKey;
    socket.emit('join_channel', payload, (res) => {
      if (res?.success) resolve(res);
      else reject(new Error(res?.error || 'join failed'));
    });
  });
}

function sendMessage(socket, channelId, clientType, message) {
  return new Promise((resolve, reject) => {
    socket.emit(
      'message',
      { id: channelId, clientType, message },
      (res) => {
        if (res?.success) resolve(res);
        else reject(new Error(res?.error || 'send failed'));
      }
    );
  });
}

/** Persistent message queue on a socket — events are NEVER lost. */
function makeMessageQueue(socket) {
  const buffered = [];
  const waiters = [];
  const drain = () => {
    while (waiters.length) {
      const head = waiters[0];
      const i = buffered.findIndex(head.pred);
      if (i < 0) return;
      const [msg] = buffered.splice(i, 1);
      waiters.shift();
      head.resolve(msg);
    }
  };
  socket.on('message', (data) => {
    buffered.push(data);
    drain();
  });
  return (pred) =>
    new Promise((resolve) => {
      waiters.push({ pred, resolve });
      drain();
    });
}

async function run() {
  let httpServer;
  let io;
  let dapp;
  let walletSocket;
  let pairingCapability;

  try {
    console.log(`1. Starting relay on port ${TEST_PORT}`);
    httpServer = createServer();
    io = createRelayServer(httpServer);
    await new Promise((resolve) => httpServer.listen(TEST_PORT, resolve));
    console.log('   Relay running');

    console.log('2. Constructing dApp provider via @qrlwallet/connect');
    dapp = new QRLConnect({
      dappMetadata: {
        name: 'E2E dApp',
        url: 'http://localhost/e2e',
      },
      relayUrl: RELAY_URL,
      chainId: '0x7e7e',
      autoReconnect: false,
      debug: false,
    });

    const uri = await dapp.getConnectionURI();
    console.log(`   URI length: ${uri.length} chars (protocol-v3 PQP3 capability-bearing blob)`);
    if (!uri.startsWith('qrlconnect://?q=')) {
      throw new Error('dApp generated a non-v3 URI');
    }

    console.log('3. Wallet: parsing URI (extracts cid + fp + capability, no pk)');
    const { cid, fp, capability } = await parseConnectionURI(uri);
    pairingCapability = capability;
    if (fp.length !== 32) throw new Error(`Wallet parsed bad fp length ${fp.length}`);
    if (pairingCapability.length !== 32) {
      throw new Error(`Wallet parsed bad capability length ${pairingCapability.length}`);
    }

    console.log('4. Wallet: joining channel on relay → receives PK from ack');
    const walletKex = new KeyExchange(false);
    walletSocket = createSocket();
    await new Promise((resolve, reject) => {
      walletSocket.on('connect', resolve);
      walletSocket.on('connect_error', reject);
    });
    const waitForMessage = makeMessageQueue(walletSocket);
    const channelIdStr = dapp.getChannelId();
    const joinAck = await joinChannel(walletSocket, channelIdStr, 'wallet');
    if (!joinAck.channelPublicKey) {
      throw new Error('Wallet did not receive channelPublicKey in join_channel ack');
    }
    const pk = fromBase64(joinAck.channelPublicKey);
    if (pk.length !== 1184) {
      throw new Error(`Relay returned bad pk length ${pk.length}`);
    }

    console.log('   Wallet: verifying PK fingerprint against QR out-of-band commitment');
    const expectedFp = await computeFingerprint(cid, pk, pairingCapability);
    if (!fingerprintEquals(fp, expectedFp)) {
      throw new Error('Fingerprint mismatch — relay may have substituted the PK');
    }

    console.log('5. Wallet: running receiveQR → Encaps + seal HELLO_WALLET');
    const synack = await walletKex.receiveQR(cid, pk, pairingCapability);
    pairingCapability.fill(0);
    if (synack.type !== KeyExchangeMessageType.SYNACK) {
      throw new Error('wallet produced wrong SYNACK type');
    }
    if (synack.v !== PROTOCOL_VERSION) {
      throw new Error(`wallet produced wrong version ${synack.v}`);
    }

    console.log('6. Wallet → dApp: SYNACK');
    await sendMessage(walletSocket, channelIdStr, 'wallet', synack);

    const ackMsg = (
      await waitForMessage(
        (d) => d?.message?.type === KeyExchangeMessageType.ACK
      )
    ).message;
    console.log(`   Wallet received ACK (c1 ${ackMsg.c1.slice(0, 16)}…)`);

    console.log('7. Wallet: verifying ACK (open c1 → HELLO_DAPP)');
    await walletKex.onAck(ackMsg);
    if (!walletKex.areKeysExchanged()) {
      throw new Error('wallet did not transition to keys_exchanged');
    }

    console.log('8. Wallet: awaiting ORIGINATOR_INFO from dApp');
    const originatorEnc = (
      await waitForMessage((d) => typeof d?.message === 'string')
    ).message;
    const originatorMsg = JSON.parse(await walletKex.decryptMessage(originatorEnc));
    if (originatorMsg.type !== MessageType.ORIGINATOR_INFO) {
      throw new Error(
        `expected ORIGINATOR_INFO, got ${JSON.stringify(originatorMsg).slice(0, 80)}`
      );
    }
    console.log(`   ORIGINATOR_INFO → ${originatorMsg.originatorInfo.name}`);

    console.log('9. Wallet → dApp: WALLET_INFO (encrypted)');
    const walletInfoPayload = JSON.stringify({
      type: MessageType.WALLET_INFO,
      accounts: [WALLET_ADDRESS],
      chainId: '0x7e7e',
    });
    await sendMessage(
      walletSocket,
      channelIdStr,
      'wallet',
      await walletKex.encryptMessage(walletInfoPayload)
    );

    // Give the dApp a moment to fold in WALLET_INFO.
    await new Promise((r) => setTimeout(r, 50));

    console.log('10. dApp: requiring explicit qrl_requestAccounts approval');
    const preApprovalAccounts = await dapp.request({ method: 'qrl_accounts' });
    if (!Array.isArray(preApprovalAccounts) || preApprovalAccounts.length !== 0) {
      throw new Error('WALLET_INFO authorized an account before explicit approval');
    }
    const accountsPromise = dapp.request({ method: 'qrl_requestAccounts' });
    const accountsRpcEnc = (
      await waitForMessage((d) => typeof d?.message === 'string')
    ).message;
    const accountsRpcMsg = JSON.parse(await walletKex.decryptMessage(accountsRpcEnc));
    if (accountsRpcMsg.method !== 'qrl_requestAccounts') {
      throw new Error(`wallet saw wrong method: ${accountsRpcMsg.method}`);
    }
    await sendMessage(
      walletSocket,
      channelIdStr,
      'wallet',
      await walletKex.encryptMessage(
        JSON.stringify({
          type: MessageType.JSONRPC,
          jsonrpc: '2.0',
          id: accountsRpcMsg.id,
          result: [WALLET_ADDRESS],
        })
      )
    );
    const approvedAccounts = await accountsPromise;
    if (approvedAccounts.length !== 1 || approvedAccounts[0] !== WALLET_ADDRESS) {
      throw new Error('dApp did not bind the explicitly approved account');
    }

    console.log('11. dApp: firing qrl_sendTransaction via provider.request()');
    const txPromise = dapp.request({
      method: 'qrl_sendTransaction',
      params: [
        {
          from: WALLET_ADDRESS,
          to: 'Q20E7Bde67f00EA38ABb2aC57e1B0DD93f518446c',
          value: '0x2386F26FC10000',
        },
      ],
    });

    const rpcEnc = (
      await waitForMessage((d) => typeof d?.message === 'string')
    ).message;
    const rpcMsg = JSON.parse(await walletKex.decryptMessage(rpcEnc));
    if (rpcMsg.method !== 'qrl_sendTransaction') {
      throw new Error(`wallet saw wrong method: ${rpcMsg.method}`);
    }
    console.log(`    Wallet decrypted JSON-RPC: ${rpcMsg.method} id=${rpcMsg.id}`);

    console.log('12. Wallet → dApp: encrypted JSON-RPC response');
    const rpcResponse = JSON.stringify({
      type: MessageType.JSONRPC,
      jsonrpc: '2.0',
      id: rpcMsg.id,
      result: TEST_TX_HASH,
    });
    await sendMessage(
      walletSocket,
      channelIdStr,
      'wallet',
      await walletKex.encryptMessage(rpcResponse)
    );

    const txResult = await txPromise;
    if (txResult !== TEST_TX_HASH) {
      throw new Error(`dApp resolved wrong result: ${txResult}`);
    }
    console.log(`    dApp resolved tx hash: ${txResult}`);

    console.log('13. dApp: firing qrl_signMessage via provider.request()');
    const MSG_HEX = '0x48656c6c6f2c20514f4c21';
    const msgRpcPromise = dapp.request({
      method: 'qrl_signMessage',
      params: [WALLET_ADDRESS, MSG_HEX],
    });
    const msgRpcEnc = (
      await waitForMessage((d) => typeof d?.message === 'string')
    ).message;
    const msgRpcMsg = JSON.parse(await walletKex.decryptMessage(msgRpcEnc));
    if (msgRpcMsg.method !== 'qrl_signMessage') {
      throw new Error(`wallet saw wrong method: ${msgRpcMsg.method}`);
    }
    const msgDigest = computeMessageDigest(hexToBytes(MSG_HEX));
    const msgSig = signE2E(msgDigest, SCHEME_TAG_MSG);
    const msgResult = {
      signature: bytesToHex(msgSig.signature),
      publicKey: bytesToHex(msgSig.publicKey),
      descriptor: WALLET_DESCRIPTOR,
      signer: WALLET_ADDRESS,
      digest: bytesToHex(msgDigest),
      schemeVersion: SCHEME_VERSION_MSG,
    };
    await sendMessage(
      walletSocket,
      channelIdStr,
      'wallet',
      await walletKex.encryptMessage(
        JSON.stringify({
          type: MessageType.JSONRPC,
          jsonrpc: '2.0',
          id: msgRpcMsg.id,
          result: msgResult,
        })
      )
    );
    const msgRpcResult = await msgRpcPromise;
    if (
      !verifyMessageForSigner({
        expectedSigner: WALLET_ADDRESS,
        descriptor: msgRpcResult.descriptor,
        signature: msgRpcResult.signature,
        publicKey: msgRpcResult.publicKey,
        messageBytes: MSG_HEX,
      })
    ) {
      throw new Error('dApp bound message verification rejected a valid signature');
    }
    console.log('    dApp verifyMessageForSigner() returned true');

    console.log('14. dApp: firing qrl_signTypedData via provider.request()');
    const TYPED_PAYLOAD = {
      types: {
        QRLDomain: [{ name: 'name', type: 'string' }],
        LoginChallenge: [
          { name: 'account', type: 'address' },
          { name: 'nonce', type: 'bytes32' },
          { name: 'issuedAt', type: 'uint64' },
        ],
      },
      primaryType: 'LoginChallenge',
      domain: { name: 'e2e.local' },
      message: {
        account: WALLET_ADDRESS,
        nonce: '0x' + 'cd'.repeat(32),
        issuedAt: '1747700000',
      },
    };
    const typedRpcPromise = dapp.request({
      method: 'qrl_signTypedData',
      params: [WALLET_ADDRESS, TYPED_PAYLOAD],
    });
    const typedRpcEnc = (
      await waitForMessage((d) => typeof d?.message === 'string')
    ).message;
    const typedRpcMsg = JSON.parse(await walletKex.decryptMessage(typedRpcEnc));
    if (typedRpcMsg.method !== 'qrl_signTypedData') {
      throw new Error(`wallet saw wrong method: ${typedRpcMsg.method}`);
    }
    const typedDigest = computeTypedDataDigest(TYPED_PAYLOAD);
    const typedSig = signE2E(typedDigest, SCHEME_TAG_TYPED);
    const typedResult = {
      signature: bytesToHex(typedSig.signature),
      publicKey: bytesToHex(typedSig.publicKey),
      descriptor: WALLET_DESCRIPTOR,
      signer: WALLET_ADDRESS,
      digest: bytesToHex(typedDigest),
      schemeVersion: SCHEME_VERSION_TYPED,
      domain: TYPED_PAYLOAD.domain,
    };
    await sendMessage(
      walletSocket,
      channelIdStr,
      'wallet',
      await walletKex.encryptMessage(
        JSON.stringify({
          type: MessageType.JSONRPC,
          jsonrpc: '2.0',
          id: typedRpcMsg.id,
          result: typedResult,
        })
      )
    );
    const typedRpcResult = await typedRpcPromise;
    if (
      !verifyTypedDataForSigner({
        expectedSigner: WALLET_ADDRESS,
        descriptor: typedRpcResult.descriptor,
        signature: typedRpcResult.signature,
        publicKey: typedRpcResult.publicKey,
        payload: TYPED_PAYLOAD,
      })
    ) {
      throw new Error('dApp bound typed-data verification rejected a valid signature');
    }
    console.log('    dApp verifyTypedDataForSigner() returned true');

    console.log('15. Wallet: leaving the relay channel (app backgrounded/closed)');
    const sawWalletLeave = new Promise((resolve) => {
      const onStatus = (status) => {
        if (status === ConnectionStatus.WAITING) {
          dapp.off('statusChanged', onStatus);
          resolve();
        }
      };
      dapp.on('statusChanged', onStatus);
    });
    walletSocket.emit('leave_channel', { channelId: channelIdStr });
    await sawWalletLeave;
    if (!dapp.isPaired()) {
      throw new Error('dApp lost its pairing when the wallet merely left the channel');
    }
    if (dapp.isWalletPresent()) {
      throw new Error('dApp still reports the wallet present after it left');
    }
    console.log('    dApp: WAITING with session intact (paired, wallet absent)');

    console.log('16. dApp: qrl_sendTransaction while the wallet is ABSENT (relay must buffer)');
    const offlineTxPromise = dapp.request({
      method: 'qrl_sendTransaction',
      params: [
        {
          from: WALLET_ADDRESS,
          to: 'Q20E7Bde67f00EA38ABb2aC57e1B0DD93f518446c',
          value: '0x1',
        },
      ],
    });
    for (let i = 0; i < 60; i++) {
      if (io.channelManager.getStats().totalBufferedMessages >= 1) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    if (io.channelManager.getStats().totalBufferedMessages < 1) {
      throw new Error('request was not buffered by the relay while the wallet was absent');
    }
    console.log('    Relay buffered the encrypted request for the absent wallet');

    console.log('17. Wallet: re-joining channel → buffered request drains from the join ack');
    const rejoinAck = await joinChannel(walletSocket, channelIdStr, 'wallet');
    const bufferedEnvelopes = (rejoinAck.bufferedMessages ?? []).filter(
      (m) => typeof m?.message === 'string'
    );
    if (bufferedEnvelopes.length !== 1) {
      throw new Error(`expected 1 buffered ciphertext in join ack, got ${bufferedEnvelopes.length}`);
    }
    const offlineRpcMsg = JSON.parse(
      await walletKex.decryptMessage(bufferedEnvelopes[0].message)
    );
    if (offlineRpcMsg.method !== 'qrl_sendTransaction') {
      throw new Error(`buffered request has wrong method: ${offlineRpcMsg.method}`);
    }
    await sendMessage(
      walletSocket,
      channelIdStr,
      'wallet',
      await walletKex.encryptMessage(
        JSON.stringify({
          type: MessageType.JSONRPC,
          jsonrpc: '2.0',
          id: offlineRpcMsg.id,
          result: TEST_TX_HASH,
        })
      )
    );
    const offlineTxResult = await offlineTxPromise;
    if (offlineTxResult !== TEST_TX_HASH) {
      throw new Error(`offline-buffered request resolved wrong result: ${offlineTxResult}`);
    }
    if (!dapp.isWalletPresent()) {
      throw new Error('dApp did not mark the wallet present again after its re-join');
    }
    console.log('    dApp resolved the request that was buffered while the wallet was away');

    console.log('18. Desync teardown: wallet skips a seq (simulated relay buffer drop)');
    // Burn one wallet sendSeq without delivering the ciphertext: exactly what
    // a relay buffer TTL/cap drop looks like to the dApp. Every subsequent
    // ciphertext must fail its tag; two in a row must tombstone the channel.
    await walletKex.encryptMessage(JSON.stringify({ type: MessageType.PING }));
    const sawTerminalDisconnect = new Promise((resolve) => {
      dapp.on('disconnect', resolve);
    });
    await sendMessage(
      walletSocket,
      channelIdStr,
      'wallet',
      await walletKex.encryptMessage(JSON.stringify({ type: MessageType.PING }))
    );
    await sendMessage(
      walletSocket,
      channelIdStr,
      'wallet',
      await walletKex.encryptMessage(JSON.stringify({ type: MessageType.PING }))
    );
    await sawTerminalDisconnect;
    if (dapp.isPaired()) {
      throw new Error('dApp still paired after an unrecoverable AEAD desync');
    }
    console.log('    dApp tore the session down after 2 consecutive tag failures');

    // The teardown must have tombstoned the channel so the wallet learns the
    // pairing is dead on its next (re)join, without any decipherable message.
    walletSocket.emit('leave_channel', { channelId: channelIdStr });
    const tombstoneAck = await joinChannel(walletSocket, channelIdStr, 'wallet');
    if (tombstoneAck.terminated !== true) {
      throw new Error('relay did not report the desynced channel as terminated');
    }
    console.log('    Relay reports terminated: true to the re-joining wallet');

    const stats = io.channelManager.getStats();
    console.log(
      `19. Relay stats: channels=${stats.activeChannels} participants=${stats.totalParticipants}`
    );

    console.log('\n✅ E2E protocol-v3 SUCCESS');
    console.log('   - PQP3 QR (cid + fingerprint + QR-only capability, no embedded PK)');
    console.log('   - Relay binds dApp PK, serves it to wallet via join_channel ack');
    console.log('   - Wallet verifies fp(cid, pk, cap) before using the relay-served key');
    console.log('   - Capability binds transcript + HKDF and blocks relay wallet impersonation');
    console.log('   - ML-KEM-768 keygen + encap + decap');
    console.log('   - AES-256-GCM bidirectional AEAD bound to transcript H_tx');
    console.log('   - SYNACK / ACK handshake over relay');
    console.log('   - ORIGINATOR_INFO / WALLET_INFO metadata exchange');
    console.log('   - WALLET_INFO cannot bypass explicit single-account authorization');
    console.log('   - qrl_sendTransaction request/response round-trip');
    console.log('   - qrl_signMessage round-trip with signer-bound local verification');
    console.log('   - qrl_signTypedData round-trip with signer-bound local verification');
    console.log('   - offline-wallet request buffered by relay + resolved on re-join');
  } catch (err) {
    console.error('\n❌ E2E TEST FAILED:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    clearTimeout(TIMEOUT);
    pairingCapability?.fill(0);
    try {
      dapp?.disconnect();
    } catch {}
    walletSocket?.disconnect();
    // createRelayServer returns { io, channelManager, destroy } since the
    // backend's TS migration; destroy() also tears down the channelManager.
    io?.destroy();
    io?.io?.close();
    httpServer?.close();
    setTimeout(() => process.exit(0), 200);
  }
}

run();
