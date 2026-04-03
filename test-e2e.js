/**
 * E2E Test: Relay Server + SDK Transport Layer
 *
 * Proves: relay routing, ECIES key exchange, encrypted JSON-RPC round-trip.
 * Run: node test-e2e.js
 */

import { createServer } from 'http';
import { io as ioClient } from 'socket.io-client';
import { PrivateKey, encrypt, decrypt } from 'eciesjs';
import { createRelayServer } from '../myqrlwallet-backend/src/relay/relayServer.js';

const TEST_PORT = 3001;
const RELAY_URL = `http://localhost:${TEST_PORT}`;
const RELAY_PATH = '/relay';
const PROTOCOL_VERSION = 1;
const CHANNEL_ID = crypto.randomUUID();

// Timeout safety net
const TIMEOUT = setTimeout(() => {
  console.error('❌ E2E TEST TIMED OUT after 15s');
  process.exit(1);
}, 15000);

// ─── ECIES helpers ────────────────────────────────────────
class TestECIES {
  constructor(existingHex) {
    this.pk = existingHex ? PrivateKey.fromHex(existingHex) : new PrivateKey();
  }
  pubHex() { return this.pk.publicKey.toHex(); }
  encrypt(plaintext, otherPubHex) {
    const enc = encrypt(otherPubHex, Buffer.from(plaintext, 'utf8'));
    return Buffer.from(enc).toString('base64');
  }
  decrypt(base64) {
    const buf = Buffer.from(base64, 'base64');
    const dec = decrypt(this.pk.toHex(), buf);
    return Buffer.from(dec).toString('utf8');
  }
}

// ─── Socket helper ────────────────────────────────────────
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
      if (res.success) resolve(res);
      else reject(new Error(res.error));
    });
  });
}

function sendMessage(socket, channelId, clientType, message) {
  return new Promise((resolve, reject) => {
    socket.emit('message', { id: channelId, clientType, message }, (res) => {
      if (res?.success) resolve(res);
      else reject(new Error(res?.error || 'send failed'));
    });
  });
}

// ─── Main test ────────────────────────────────────────────
async function run() {
  let httpServer, io, dappSocket, walletSocket;

  try {
    // ── Step 1: Start relay server ──
    console.log('1. Starting relay server on port', TEST_PORT);
    httpServer = createServer();
    io = createRelayServer(httpServer);
    await new Promise((resolve) => httpServer.listen(TEST_PORT, resolve));
    console.log('   Relay running');

    // ── Step 2: Create dApp-side ECIES keypair + socket ──
    console.log('2. Simulating dApp: generating keypair, connecting to relay');
    const dappEcies = new TestECIES();
    dappSocket = createSocket();
    await new Promise((resolve, reject) => {
      dappSocket.on('connect', resolve);
      dappSocket.on('connect_error', reject);
    });
    await joinChannel(dappSocket, CHANNEL_ID, 'dapp');
    console.log(`   dApp connected, channel: ${CHANNEL_ID.slice(0, 8)}...`);

    // Generate the connection URI (same format as the SDK)
    const uri = `qrlconnect://?channelId=${CHANNEL_ID}&pubKey=${dappEcies.pubHex()}&name=TestdApp&url=http://localhost&chainId=0x7e7e&relay=${encodeURIComponent(RELAY_URL)}`;
    console.log(`   URI generated: ${uri.slice(0, 60)}...`);

    // ── Step 3: Create wallet-side ECIES keypair + socket ──
    console.log('3. Simulating wallet: parsing URI, connecting to relay');
    const walletEcies = new TestECIES();
    walletSocket = createSocket();
    await new Promise((resolve, reject) => {
      walletSocket.on('connect', resolve);
      walletSocket.on('connect_error', reject);
    });
    await joinChannel(walletSocket, CHANNEL_ID, 'wallet');
    console.log('   Wallet connected to same channel');

    // ── Step 4: 3-step key exchange (SYN → SYNACK → ACK) ──
    console.log('4. Running ECIES key exchange...');

    // 4a: dApp sends SYN with its public key
    const synMsg = {
      type: 'key_handshake_SYN',
      pubkey: dappEcies.pubHex(),
      v: PROTOCOL_VERSION,
    };

    // Set up wallet listener for SYN before dApp sends it
    const walletReceivedSyn = new Promise((resolve) => {
      walletSocket.on('message', function handler(data) {
        if (data.message?.type === 'key_handshake_SYN') {
          walletSocket.off('message', handler);
          resolve(data.message);
        }
      });
    });

    await sendMessage(dappSocket, CHANNEL_ID, 'dapp', synMsg);
    const syn = await walletReceivedSyn;
    console.log(`   SYN received by wallet (pubkey: ${syn.pubkey.slice(0, 16)}...)`);

    // 4b: Wallet stores dApp pubkey, sends SYNACK with wallet's pubkey
    const dappPubKey = syn.pubkey;
    const synackMsg = {
      type: 'key_handshake_SYNACK',
      pubkey: walletEcies.pubHex(),
      v: PROTOCOL_VERSION,
    };

    const dappReceivedSynack = new Promise((resolve) => {
      dappSocket.on('message', function handler(data) {
        if (data.message?.type === 'key_handshake_SYNACK') {
          dappSocket.off('message', handler);
          resolve(data.message);
        }
      });
    });

    await sendMessage(walletSocket, CHANNEL_ID, 'wallet', synackMsg);
    const synack = await dappReceivedSynack;
    console.log(`   SYNACK received by dApp (pubkey: ${synack.pubkey.slice(0, 16)}...)`);

    // 4c: dApp stores wallet pubkey, sends ACK
    const walletPubKey = synack.pubkey;
    const ackMsg = { type: 'key_handshake_ACK', v: PROTOCOL_VERSION };

    const walletReceivedAck = new Promise((resolve) => {
      walletSocket.on('message', function handler(data) {
        if (data.message?.type === 'key_handshake_ACK') {
          walletSocket.off('message', handler);
          resolve(data.message);
        }
      });
    });

    await sendMessage(dappSocket, CHANNEL_ID, 'dapp', ackMsg);
    await walletReceivedAck;
    console.log('   ACK received by wallet — key exchange COMPLETE');

    // ── Step 5: Verify cross-encryption works ──
    console.log('5. Verifying ECIES cross-encryption...');
    const testPlain = 'Hello from dApp!';
    const encrypted = dappEcies.encrypt(testPlain, walletPubKey);
    const decrypted = walletEcies.decrypt(encrypted);
    if (decrypted !== testPlain) throw new Error(`Decryption mismatch: got "${decrypted}"`);
    console.log('   dApp→wallet encryption verified');

    const testPlain2 = 'Hello from wallet!';
    const encrypted2 = walletEcies.encrypt(testPlain2, dappPubKey);
    const decrypted2 = dappEcies.decrypt(encrypted2);
    if (decrypted2 !== testPlain2) throw new Error(`Decryption mismatch: got "${decrypted2}"`);
    console.log('   wallet→dApp encryption verified');

    // ── Step 6: dApp sends encrypted qrl_sendTransaction request ──
    console.log('6. dApp sending encrypted qrl_sendTransaction...');
    const jsonRpcRequest = {
      type: 'jsonrpc',
      jsonrpc: '2.0',
      id: 1,
      method: 'qrl_sendTransaction',
      params: [{
        from: 'Q208318ecd68f26726CE7C54b29CaBA94584969B6',
        to: 'Q20E7Bde67f00EA38ABb2aC57e1B0DD93f518446c',
        value: '0x2386F26FC10000',
      }],
    };

    const encryptedRpc = dappEcies.encrypt(JSON.stringify(jsonRpcRequest), walletPubKey);

    const walletReceivedRpc = new Promise((resolve) => {
      walletSocket.on('message', function handler(data) {
        if (typeof data.message === 'string') {
          walletSocket.off('message', handler);
          resolve(data.message);
        }
      });
    });

    await sendMessage(dappSocket, CHANNEL_ID, 'dapp', encryptedRpc);
    const encryptedPayload = await walletReceivedRpc;

    // Wallet decrypts
    const decryptedRpc = JSON.parse(walletEcies.decrypt(encryptedPayload));
    console.log(`   Wallet decrypted: method=${decryptedRpc.method}, id=${decryptedRpc.id}`);
    console.log(`   Params: from=${decryptedRpc.params[0].from}, to=${decryptedRpc.params[0].to}, value=${decryptedRpc.params[0].value}`);

    if (decryptedRpc.method !== 'qrl_sendTransaction') {
      throw new Error(`Wrong method: ${decryptedRpc.method}`);
    }
    if (decryptedRpc.params[0].from !== 'Q208318ecd68f26726CE7C54b29CaBA94584969B6') {
      throw new Error('From address mismatch');
    }

    // ── Step 7: Wallet sends encrypted JSON-RPC response back ──
    console.log('7. Wallet sending encrypted response...');
    const jsonRpcResponse = {
      type: 'jsonrpc',
      jsonrpc: '2.0',
      id: 1,
      result: '0x3e306b5a5a37532e1734503f7d2427a86f2c992fbe471f5be403b9f734e661c5',
    };

    const encryptedResponse = walletEcies.encrypt(JSON.stringify(jsonRpcResponse), dappPubKey);

    const dappReceivedResponse = new Promise((resolve) => {
      dappSocket.on('message', function handler(data) {
        if (typeof data.message === 'string') {
          dappSocket.off('message', handler);
          resolve(data.message);
        }
      });
    });

    await sendMessage(walletSocket, CHANNEL_ID, 'wallet', encryptedResponse);
    const encryptedResult = await dappReceivedResponse;

    // dApp decrypts
    const decryptedResponse = JSON.parse(dappEcies.decrypt(encryptedResult));
    console.log(`   dApp received txHash: ${decryptedResponse.result}`);

    if (decryptedResponse.id !== 1) throw new Error('Response id mismatch');
    if (!decryptedResponse.result.startsWith('0x')) throw new Error('Invalid tx hash');

    // ── Step 8: Verify relay stats ──
    console.log('8. Checking relay stats...');
    const stats = io.channelManager.getStats();
    console.log(`   Active channels: ${stats.activeChannels}, participants: ${stats.totalParticipants}`);

    // ── Done! ──
    console.log('\n✅ E2E TEST SUCCESS');
    console.log('   - Relay server: routing messages between dApp ↔ wallet');
    console.log('   - ECIES key exchange: 3-step SYN/SYNACK/ACK completed');
    console.log('   - Encryption: bidirectional encrypt/decrypt verified');
    console.log('   - JSON-RPC: qrl_sendTransaction request/response round-trip');

  } catch (err) {
    console.error('\n❌ E2E TEST FAILED:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    // Clean shutdown
    clearTimeout(TIMEOUT);
    dappSocket?.disconnect();
    walletSocket?.disconnect();
    io?.channelManager?.destroy();
    io?.close();
    httpServer?.close();
    // Give sockets time to close
    setTimeout(() => process.exit(0), 200);
  }
}

run();
