/**
 * E2E Test: QRL Connect v2 — relay + post-quantum handshake + JSON-RPC round-trip.
 *
 * Exercises the real built SDK (dist/index.mjs) as the dApp, and a minimal
 * wallet simulator built on top of the SDK's KeyExchange (isOriginator=false)
 * against a real Socket.IO relay.
 *
 * Run: node test-e2e.js
 */

import { createServer } from 'http';
import { io as ioClient } from 'socket.io-client';
import { createRelayServer } from '../myqrlwallet-backend/src/relay/relayServer.js';
import {
  QRLConnect,
  KeyExchange,
  parseConnectionURI,
  KeyExchangeMessageType,
  MessageType,
  PROTOCOL_VERSION,
} from './dist/index.mjs';

const TEST_PORT = 3001;
const RELAY_URL = `http://localhost:${TEST_PORT}`;
const RELAY_PATH = '/relay';

const WALLET_ADDRESS = 'Q208318ecd68f26726CE7C54b29CaBA94584969B6';
const TEST_TX_HASH =
  '0x3e306b5a5a37532e1734503f7d2427a86f2c992fbe471f5be403b9f734e661c5';

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

function joinChannel(socket, channelId, clientType) {
  return new Promise((resolve, reject) => {
    socket.emit('join_channel', { channelId, clientType }, (res) => {
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
    console.log(`   URI length: ${uri.length} chars (v2 PQP1 blob)`);
    if (!uri.startsWith('qrlconnect://?q=')) {
      throw new Error('dApp generated a non-v2 URI');
    }

    console.log('3. Wallet: parsing URI (extracts cid + pk)');
    const { cid, pk } = await parseConnectionURI(uri);
    if (pk.length !== 1184) throw new Error(`Wallet parsed bad pk length ${pk.length}`);

    console.log('4. Wallet: joining channel on relay');
    const walletKex = new KeyExchange(false);
    walletSocket = createSocket();
    await new Promise((resolve, reject) => {
      walletSocket.on('connect', resolve);
      walletSocket.on('connect_error', reject);
    });
    const waitForMessage = makeMessageQueue(walletSocket);
    const channelIdStr = dapp.getChannelId();
    await joinChannel(walletSocket, channelIdStr, 'wallet');

    console.log('5. Wallet: running receiveQR → Encaps + seal HELLO_WALLET');
    const synack = await walletKex.receiveQR(cid, pk);
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

    console.log('10. dApp: firing qrl_sendTransaction via provider.request()');
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

    console.log('11. Wallet → dApp: encrypted JSON-RPC response');
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

    const stats = io.channelManager.getStats();
    console.log(
      `12. Relay stats: channels=${stats.activeChannels} participants=${stats.totalParticipants}`
    );

    console.log('\n✅ E2E v2 SUCCESS');
    console.log('   - ML-KEM-768 keygen + encap + decap');
    console.log('   - AES-256-GCM bidirectional AEAD bound to transcript H_tx');
    console.log('   - SYNACK / ACK handshake over relay');
    console.log('   - ORIGINATOR_INFO / WALLET_INFO metadata exchange');
    console.log('   - qrl_sendTransaction request/response round-trip');
  } catch (err) {
    console.error('\n❌ E2E TEST FAILED:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    clearTimeout(TIMEOUT);
    try {
      dapp?.disconnect();
    } catch {}
    walletSocket?.disconnect();
    io?.channelManager?.destroy();
    io?.close();
    httpServer?.close();
    setTimeout(() => process.exit(0), 200);
  }
}

run();
