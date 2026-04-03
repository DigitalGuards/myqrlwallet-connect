import { QRLConnect, ConnectionStatus } from '@qrlwallet/connect';
import QRCode from 'qrcode';

// ─── Config ──────────────────────────────────────────────
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
const btnNewConn  = $('btn-new-connection');
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

// ─── QRLConnect instance (created once, persists across page loads) ───
let connectedAccount = null;
let userDisconnected = false; // Track if disconnect was user-initiated

const qrl = new QRLConnect({
  dappMetadata: {
    name: 'QRL Connect Test dApp',
    url: location.origin,
  },
  relayUrl: RELAY_URL,
  debug: true,
  autoReconnect: true,
});

function showConnectedUI(accounts) {
  connectedAccount = accounts?.[0] || null;
  accountAddr.textContent = connectedAccount;
  accountInfo.classList.remove('hidden');
  qrContainer.classList.add('hidden');
  uriDisplay.classList.add('hidden');
  btnConnect.classList.add('hidden');
  btnNewConn.classList.remove('hidden');
  btnDisconnect.classList.remove('hidden');
  btnSend.disabled = false;
  btnSign.disabled = false;
  btnRpc.disabled = false;
}

function showDisconnectedUI() {
  connectedAccount = null;
  accountInfo.classList.add('hidden');
  btnDisconnect.classList.add('hidden');
  btnSend.disabled = true;
  btnSign.disabled = true;
  btnRpc.disabled = true;
  btnConnect.classList.remove('hidden');
  btnNewConn.classList.add('hidden');
}

// ─── Wire events ─────────────────────────────────────────
qrl.on('connect', ({ chainId }) => {
  log(`Wallet connected (chainId: ${chainId})`, 'success');
  updateStatus(ConnectionStatus.CONNECTED);
});

qrl.on('disconnect', async ({ code, message }) => {
  log(`Wallet disconnected: ${message} (${code})`, 'error');
  updateStatus(ConnectionStatus.DISCONNECTED);

  if (userDisconnected) {
    // User clicked Disconnect — show clean state
    userDisconnected = false;
    showDisconnectedUI();
    return;
  }

  // Wallet-initiated disconnect — auto-regenerate QR so user can reconnect
  showDisconnectedUI();
  log('Regenerating QR code for reconnection...', 'info');
  try {
    const uri = await qrl.getConnectionURI();
    await showQR(uri);
    log(`QR ready — scan to reconnect (channel: ${qrl.getChannelId()})`, 'info');
    updateStatus(ConnectionStatus.WAITING);
  } catch (err) {
    log(`Failed to regenerate QR: ${err.message}`, 'error');
  }
});

qrl.on('accountsChanged', (accounts) => {
  log(`Accounts: ${accounts.join(', ')}`, 'success');
  showConnectedUI(accounts);
});

qrl.on('chainChanged', (chainId) => {
  log(`Chain changed: ${chainId}`, 'info');
});

qrl.on('statusChanged', (status) => {
  updateStatus(status);
});

// ─── Show QR code helper ─────────────────────────────────
async function showQR(uri) {
  qrContainer.classList.remove('hidden');
  await QRCode.toCanvas(qrCanvas, uri, {
    width: 280,
    margin: 2,
    color: { dark: '#000000', light: '#ffffff' },
  });
  uriDisplay.textContent = uri;
  uriDisplay.classList.remove('hidden');
}

// ─── Mobile deep link helper ──────────────────────────────
function tryOpenMobileDeepLink(uri, sourceLabel) {
  if (!qrl.isMobile()) return false;

  log(`[Mobile] Deep link attempt (${sourceLabel})`, 'info');
  log(`[Mobile] URI: ${uri}`, 'info');

  let settled = false;
  const cleanup = () => {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('pagehide', onPageHide);
  };

  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden' && !settled) {
      settled = true;
      log('[Mobile] Page hidden after deep link attempt (wallet likely opened)', 'success');
      cleanup();
    }
  };

  const onPageHide = () => {
    if (!settled) {
      settled = true;
      log('[Mobile] Page backgrounded after deep link attempt', 'success');
      cleanup();
    }
  };

  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', onPageHide);

  setTimeout(() => {
    if (!settled && document.visibilityState === 'visible') {
      settled = true;
      log('[Mobile] Deep link may have been blocked (still on dApp page)', 'error');
      cleanup();
    }
  }, 1500);

  window.location.href = uri;
  return true;
}

// ─── Connect (first time) ───────────────────────────────
btnConnect.addEventListener('click', async () => {
  btnConnect.disabled = true;
  btnConnect.textContent = 'Generating...';
  log('Creating connection...', 'info');

  try {
    const uri = await qrl.getConnectionURI();
    log(`Connection URI generated (channel: ${qrl.getChannelId()})`, 'info');
    const openedMobile = tryOpenMobileDeepLink(uri, 'connect');
    if (!openedMobile) {
      await showQR(uri);
    }
    btnConnect.textContent = 'Connect Wallet';
    btnConnect.disabled = false;
    updateStatus(ConnectionStatus.WAITING);
  } catch (err) {
    log(`Connection error: ${err.message}`, 'error');
    btnConnect.textContent = 'Connect Wallet';
    btnConnect.disabled = false;
  }
});

// ─── New Connection (reset channel and re-pair) ──────────
btnNewConn.addEventListener('click', async () => {
  btnNewConn.disabled = true;
  btnNewConn.textContent = 'Generating...';
  log('Creating new connection (resetting existing session)...', 'info');

  try {
    const uri = await qrl.newConnection();
    log(`New connection URI generated (channel: ${qrl.getChannelId()})`, 'info');
    showDisconnectedUI();
    const openedMobile = tryOpenMobileDeepLink(uri, 'newConnection');
    if (!openedMobile) {
      await showQR(uri);
    }
    btnNewConn.textContent = 'New Connection';
    btnNewConn.disabled = false;
    // Keep "New Connection" visible while waiting for scan
    btnConnect.classList.add('hidden');
    btnNewConn.classList.remove('hidden');
    updateStatus(ConnectionStatus.WAITING);
  } catch (err) {
    log(`New connection error: ${err.message}`, 'error');
    btnNewConn.textContent = 'New Connection';
    btnNewConn.disabled = false;
  }
});

// ─── Disconnect ──────────────────────────────────────────
btnDisconnect.addEventListener('click', () => {
  userDisconnected = true;
  qrl.disconnect();
  log('Disconnected', 'info');
  updateStatus(ConnectionStatus.DISCONNECTED);
  showDisconnectedUI();
});

// ─── Send Transaction ────────────────────────────────────
btnSend.addEventListener('click', async () => {
  const to = $('tx-to').value.trim();
  const qrlAmount = $('tx-value').value.trim();

  if (!to) { log('Enter a recipient address', 'error'); return; }
  if (!qrlAmount || isNaN(Number(qrlAmount))) { log('Enter a valid amount', 'error'); return; }

  const weiValue = '0x' + (BigInt(Math.floor(Number(qrlAmount) * 1e18))).toString(16);

  btnSend.disabled = true;
  btnSend.textContent = 'Waiting for approval...';
  txResult.classList.add('hidden');
  log(`Sending ${qrlAmount} QRL to ${to}...`, 'info');

  try {
    const txHash = await qrl.request({
      method: 'qrl_sendTransaction',
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

  if (method === 'qrl_getBalance' && connectedAccount) {
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

if (qrl.hasStoredSession()) {
  log('Found existing session, reconnecting...', 'info');
  updateStatus(ConnectionStatus.RECONNECTING);
} else {
  log('No stored session. Click "Connect Wallet" to start.', 'info');
}
