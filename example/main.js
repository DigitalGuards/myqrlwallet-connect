import { QRLConnect, ConnectionStatus } from '@qrlwallet/connect';
import QRCode from 'qrcode';

// ─── Config ──────────────────────────────────────────────
// Point at local backend during development, production relay otherwise
const RELAY_URL = 'https://qrlwallet.com';

// ─── DOM refs ────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const statusDot   = $('status-dot');
const statusText  = $('status-text');
const qrContainer = $('qr-container');
const qrCanvas    = $('qr-canvas');
const uriDisplay  = $('uri-display');
const accountInfo = $('account-info');
const accountAddr = $('account-address');
const btnConnect  = $('btn-connect');
const btnDisconnect = $('btn-disconnect');
const btnSend     = $('btn-send');
const btnSign     = $('btn-sign');
const btnRpc      = $('btn-rpc');
const txResult    = $('tx-result');
const signResult  = $('sign-result');
const rpcResult   = $('rpc-result');
const logArea     = $('log-area');

// ─── Logger ──────────────────────────────────────────────
function log(msg, type = '') {
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  const time = new Date().toLocaleTimeString();
  entry.textContent = `[${time}] ${msg}`;
  logArea.appendChild(entry);
  logArea.scrollTop = logArea.scrollHeight;
}

// ─── Status display ──────────────────────────────────────
const STATUS_CONFIG = {
  [ConnectionStatus.DISCONNECTED]:  { color: 'red',    label: 'Disconnected' },
  [ConnectionStatus.CONNECTING]:    { color: 'yellow', label: 'Connecting to relay...' },
  [ConnectionStatus.WAITING]:       { color: 'yellow', label: 'Waiting for wallet scan...' },
  [ConnectionStatus.KEY_EXCHANGE]:  { color: 'yellow', label: 'Exchanging keys...' },
  [ConnectionStatus.CONNECTED]:     { color: 'green',  label: 'Connected' },
  [ConnectionStatus.RECONNECTING]:  { color: 'yellow', label: 'Reconnecting...' },
};

function updateStatus(status) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG[ConnectionStatus.DISCONNECTED];
  statusDot.className = `dot ${cfg.color}`;
  statusText.textContent = cfg.label;
}

// ─── QRLConnect instance ─────────────────────────────────
let qrl = null;
let connectedAccount = null;

function setConnected(accounts) {
  connectedAccount = accounts?.[0] || null;
  if (connectedAccount) {
    accountAddr.textContent = connectedAccount;
    accountInfo.classList.remove('hidden');
    btnConnect.classList.add('hidden');
    btnDisconnect.classList.remove('hidden');
    qrContainer.classList.add('hidden');
    uriDisplay.classList.add('hidden');
    btnSend.disabled = false;
    btnSign.disabled = false;
    btnRpc.disabled = false;
  } else {
    accountInfo.classList.add('hidden');
    btnConnect.classList.remove('hidden');
    btnDisconnect.classList.add('hidden');
    btnSend.disabled = true;
    btnSign.disabled = true;
    btnRpc.disabled = true;
  }
}

// ─── Connect ─────────────────────────────────────────────
btnConnect.addEventListener('click', async () => {
  btnConnect.disabled = true;
  btnConnect.textContent = 'Generating...';
  log('Creating connection...', 'info');

  try {
    qrl = new QRLConnect({
      dappMetadata: {
        name: 'QRL Connect Test dApp',
        url: location.origin,
      },
      relayUrl: RELAY_URL,
      debug: true,
      autoReconnect: false,
    });

    // Wire events
    qrl.on('connect', ({ chainId }) => {
      log(`Wallet connected (chainId: ${chainId})`, 'success');
      updateStatus(ConnectionStatus.CONNECTED);
    });

    qrl.on('disconnect', ({ code, message }) => {
      log(`Wallet disconnected: ${message} (${code})`, 'error');
      updateStatus(ConnectionStatus.DISCONNECTED);
      setConnected(null);
    });

    qrl.on('accountsChanged', (accounts) => {
      log(`Accounts: ${accounts.join(', ')}`, 'success');
      setConnected(accounts);
    });

    qrl.on('chainChanged', (chainId) => {
      log(`Chain changed: ${chainId}`, 'info');
    });

    // Status tracking
    qrl.connectionManager?.on?.('status_changed', (status) => {
      updateStatus(status);
    });

    // Generate URI
    const uri = await qrl.getConnectionURI();
    log(`Connection URI generated (channel: ${qrl.getChannelId()})`, 'info');

    // Render QR
    qrContainer.classList.remove('hidden');
    await QRCode.toCanvas(qrCanvas, uri, {
      width: 280,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' },
    });

    // Show raw URI (helpful for debugging / manual testing)
    uriDisplay.textContent = uri;
    uriDisplay.classList.remove('hidden');

    btnConnect.textContent = 'Generate QR Code';
    btnConnect.disabled = false;
    updateStatus(ConnectionStatus.WAITING);

  } catch (err) {
    log(`Connection error: ${err.message}`, 'error');
    btnConnect.textContent = 'Generate QR Code';
    btnConnect.disabled = false;
  }
});

// ─── Disconnect ──────────────────────────────────────────
btnDisconnect.addEventListener('click', () => {
  if (qrl) {
    qrl.disconnect();
    qrl = null;
  }
  log('Disconnected', 'info');
  updateStatus(ConnectionStatus.DISCONNECTED);
  setConnected(null);
});

// ─── Send Transaction ────────────────────────────────────
btnSend.addEventListener('click', async () => {
  const to = $('tx-to').value.trim();
  const qrlAmount = $('tx-value').value.trim();

  if (!to) { log('Enter a recipient address', 'error'); return; }
  if (!qrlAmount || isNaN(Number(qrlAmount))) { log('Enter a valid amount', 'error'); return; }

  // Convert QRL to wei (1 QRL = 1e18 wei)
  const weiValue = '0x' + (BigInt(Math.floor(Number(qrlAmount) * 1e18))).toString(16);

  btnSend.disabled = true;
  btnSend.textContent = 'Waiting for approval...';
  txResult.classList.add('hidden');
  log(`Sending ${qrlAmount} QRL to ${to}...`, 'info');

  try {
    const txHash = await qrl.request({
      method: 'zond_sendTransaction',
      params: [{
        from: connectedAccount,
        to,
        value: weiValue,
      }],
    });

    log(`Transaction confirmed: ${txHash}`, 'success');
    txResult.textContent = `tx: ${txHash}`;
    txResult.classList.remove('hidden');
  } catch (err) {
    log(`Transaction failed: ${err.message}`, 'error');
    txResult.textContent = `Error: ${err.message}`;
    txResult.classList.remove('hidden');
  } finally {
    btnSend.disabled = false;
    btnSend.textContent = 'Send Transaction';
  }
});

// ─── Sign Message ────────────────────────────────────────
btnSign.addEventListener('click', async () => {
  const message = $('sign-message').value.trim();
  if (!message) { log('Enter a message to sign', 'error'); return; }

  btnSign.disabled = true;
  btnSign.textContent = 'Waiting for approval...';
  signResult.classList.add('hidden');
  log(`Requesting signature for: "${message}"`, 'info');

  try {
    const signature = await qrl.request({
      method: 'personal_sign',
      params: [message, connectedAccount],
    });

    log('Message signed successfully', 'success');
    signResult.textContent = `sig: ${signature}`;
    signResult.classList.remove('hidden');
  } catch (err) {
    log(`Signing failed: ${err.message}`, 'error');
    signResult.textContent = `Error: ${err.message}`;
    signResult.classList.remove('hidden');
  } finally {
    btnSign.disabled = false;
    btnSign.textContent = 'Sign Message';
  }
});

// ─── Read-only RPC ───────────────────────────────────────
btnRpc.addEventListener('click', async () => {
  const method = $('rpc-method').value;
  let params = undefined;

  // zond_getBalance needs the account address + 'latest'
  if (method === 'zond_getBalance' && connectedAccount) {
    params = [connectedAccount, 'latest'];
  }

  btnRpc.disabled = true;
  rpcResult.classList.add('hidden');
  log(`Calling ${method}...`, 'info');

  try {
    const result = await qrl.request({ method, params });
    const display = typeof result === 'string' ? result : JSON.stringify(result, null, 2);

    log(`${method} => ${display}`, 'success');
    rpcResult.textContent = display;
    rpcResult.classList.remove('hidden');
  } catch (err) {
    log(`${method} failed: ${err.message}`, 'error');
    rpcResult.textContent = `Error: ${err.message}`;
    rpcResult.classList.remove('hidden');
  } finally {
    btnRpc.disabled = false;
  }
});

// ─── Init ────────────────────────────────────────────────
log(`Relay: ${RELAY_URL}`, 'info');
log(`Platform: ${navigator.userAgent.includes('Mobile') ? 'Mobile' : 'Desktop'}`, 'info');
