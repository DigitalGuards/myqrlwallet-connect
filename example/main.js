import {
  QRLConnect,
  ConnectionStatus,
  QRL_CONNECT_PROVIDER_INFO,
  verifyMessage,
  verifyTypedData,
  bytesToHex,
  getAppStoreUrl,
} from '@qrlwallet/connect';
import QRCode from 'qrcode';

// ─── Config ──────────────────────────────────────────────
// Local dev override: set VITE_RELAY_URL before `vite` (e.g. via
// start-test-env.sh) to point at your local backend relay instead of prod.
const RELAY_URL = import.meta.env.VITE_RELAY_URL || 'https://qrlwallet.com';

// ─── DOM refs ────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const statusDot       = $('status-dot');
const statusText      = $('status-text');
const qrContainer     = $('qr-container');
const qrCanvas        = $('qr-canvas');
const uriDisplay      = $('uri-display');
const accountInfo     = $('account-info');
const accountAddr     = $('account-address');
const activeWalletEl  = $('active-wallet');
const walletPicker    = $('wallet-picker');
const walletList      = $('wallet-list');
const btnNewConn      = $('btn-new-connection');
const btnDisconnect   = $('btn-disconnect');
const btnSwitchWallet = $('btn-switch-wallet');
const desktopActions  = $('desktop-actions');
const btnOpenDesktop  = $('btn-open-desktop');
const btnCopyUri      = $('btn-copy-uri');
const btnSend         = $('btn-send');
const btnSign         = $('btn-sign');
const btnSignTyped    = $('btn-sign-typed');
const signTypedInput  = $('sign-typed-payload');
const btnRpc          = $('btn-rpc');
const txResult        = $('tx-result');
const signResult      = $('sign-result');
const signTypedResult = $('sign-typed-result');
const rpcResult       = $('rpc-result');
const logArea         = $('log-area');

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

// Direct status writer for non-relay flows (e.g. extension), so we don't
// reuse the relay-specific labels in `STATUS_CONFIG`.
function setStatus(color, label) {
  statusDot.className = `dot ${color}`;
  statusText.textContent = label;
}

// ─── EIP-6963 wallet discovery ───────────────────────────
//
// The dApp listens for any wallet that announces itself via EIP-6963 - both
// the official QRL browser extension (rdns: theqrl.org) and our own SDK
// (rdns: com.qrlwallet.connect, announced when QRLConnect is constructed).
// Injected QRL extensions: the upstream QRL Web3 Wallet and the
// MyQRLWallet Extension fork (com.qrlwallet.extension). Both take the
// extension tx shape; everything else EIP-1193-compatible is listed too
// since this example doubles as a diagnostic harness.
const QRL_EXTENSION_RDNS = new Set(['theqrl.org', 'com.qrlwallet.extension']);
const QRL_CONNECT_RDNS   = QRL_CONNECT_PROVIDER_INFO.rdns;

const discovered = new Map(); // uuid -> { info, provider }

function renderWalletPicker() {
  walletList.innerHTML = '';
  if (discovered.size === 0) {
    const empty = document.createElement('div');
    empty.className = 'wallet-empty';
    empty.textContent = 'No QRL wallets detected. Install the QRL Web3 Wallet extension or use MyQRLWallet on mobile.';
    walletList.appendChild(empty);
    return;
  }
  for (const detail of discovered.values()) {
    const row = document.createElement('button');
    row.className = 'wallet-row';

    // Build with createElement + textContent rather than innerHTML - wallet
    // metadata is attacker-controlled (any page script can dispatch
    // `eip6963:announceProvider`), so any HTML interpolation is XSS.
    const icon = document.createElement('img');
    icon.className = 'wallet-icon';
    icon.src = detail.info.icon;
    icon.alt = detail.info.name;

    const name = document.createElement('span');
    name.className = 'wallet-name';
    name.textContent = detail.info.name;

    const rdns = document.createElement('span');
    rdns.className = 'wallet-rdns';
    rdns.textContent = detail.info.rdns;

    row.append(icon, name, rdns);
    row.addEventListener('click', () => connectWith(detail));
    walletList.appendChild(row);
  }
}

function showPicker() {
  walletPicker.classList.remove('hidden');
}

function hidePicker() {
  walletPicker.classList.add('hidden');
}

// ─── QRLConnect (mobile relay) instance ──────────────────
//
// Constructing it triggers the EIP-6963 announce, so it shows up in our
// own picker alongside any extension provider.
let connectedAccount = null;
let userDisconnected = false;
let typedEdited = false; // becomes true once the user edits the typed-data box
let activeProvider = null;       // The wallet provider currently in use.
let activeProviderInfo = null;   // EIP-6963 info for the active wallet.

const qrl = new QRLConnect({
  dappMetadata: {
    name: 'QRL Connect Test dApp',
    url: location.origin,
    // Return-to-dApp target (WalletConnect-style peer redirect): after the
    // wallet approves a request on mobile, it bounces the user back here
    // instead of stranding them in the wallet app.
    redirectUrl: location.href,
  },
  relayUrl: RELAY_URL,
  debug: true,
  autoReconnect: true,
});

window.addEventListener('eip6963:announceProvider', (event) => {
  const { detail } = event;
  if (!detail?.info?.uuid) return;
  if (discovered.has(detail.info.uuid)) return;
  discovered.set(detail.info.uuid, detail);
  log(`Wallet detected: ${detail.info.name} (${detail.info.rdns})`, 'info');
  renderWalletPicker();
});

// Spec: dispatch requestProvider after listener is registered so any wallet
// that already announced before we listened will re-announce.
window.dispatchEvent(new Event('eip6963:requestProvider'));

// ─── Active-wallet UI helpers ────────────────────────────
function showConnectedUI(accounts, providerInfo) {
  connectedAccount = accounts?.[0] || null;
  // Reflect the connected account as the StakeIntent staker (unless edited).
  if (!typedEdited) refreshTypedPlaceholder();
  accountAddr.textContent = connectedAccount;
  activeWalletEl.textContent = providerInfo
    ? `${providerInfo.name} (${providerInfo.rdns})`
    : '';
  accountInfo.classList.remove('hidden');
  qrContainer.classList.add('hidden');
  uriDisplay.classList.add('hidden');
  desktopActions.classList.add('hidden');
  hidePicker();
  btnDisconnect.classList.remove('hidden');
  btnSwitchWallet.classList.remove('hidden');
  // "New Connection" only makes sense for the relay flow, not the extension.
  if (providerInfo?.rdns === QRL_CONNECT_RDNS) {
    btnNewConn.classList.remove('hidden');
  } else {
    btnNewConn.classList.add('hidden');
  }
  btnSend.disabled = false;
  btnSign.disabled = false;
  btnSignTyped.disabled = false;
  btnRpc.disabled = false;
}

function showDisconnectedUI() {
  connectedAccount = null;
  activeProvider = null;
  activeProviderInfo = null;
  accountInfo.classList.add('hidden');
  // Disconnected must never display a live-looking connection surface: the
  // QR, code text, and desktop deep-link/copy actions all point at a channel
  // that no longer exists (showQR re-shows them when a fresh URI is ready).
  qrContainer.classList.add('hidden');
  uriDisplay.classList.add('hidden');
  desktopActions.classList.add('hidden');
  btnDisconnect.classList.add('hidden');
  btnNewConn.classList.add('hidden');
  btnSwitchWallet.classList.add('hidden');
  btnSend.disabled = true;
  btnSign.disabled = true;
  btnSignTyped.disabled = true;
  btnRpc.disabled = true;
  showPicker();
}

// ─── SDK event wiring (relay flow) ───────────────────────
qrl.on('connect', ({ chainId }) => {
  log(`Wallet connected (chainId: ${chainId})`, 'success');
  updateStatus(ConnectionStatus.CONNECTED);
  // Re-emit on auto-reconnect: accounts didn't change, but UI should refresh.
  const cached = qrl.getAccounts();
  if (cached.length > 0 && activeProvider === qrl) {
    showConnectedUI(cached, activeProviderInfo);
  }
});

qrl.on('disconnect', async ({ code, message }) => {
  log(`Wallet disconnected: ${message} (${code})`, 'error');
  updateStatus(ConnectionStatus.DISCONNECTED);

  if (activeProvider !== qrl) return;

  if (userDisconnected) {
    userDisconnected = false;
    showDisconnectedUI();
    return;
  }

  // Wallet-initiated disconnect: auto-regenerate QR so user can reconnect.
  // Hide the picker - we know the user just had a relay session, so the QR
  // is the right thing to show, not a wallet picker on top of it.
  showDisconnectedUI();
  hidePicker();
  log('Regenerating QR code for reconnection...', 'info');
  try {
    activeProvider = qrl;
    activeProviderInfo = {
      name: QRL_CONNECT_PROVIDER_INFO.name,
      rdns: QRL_CONNECT_RDNS,
    };
    const uri = await qrl.getConnectionURI();
    await showQR(uri);
    log(`QR ready. Scan to reconnect (channel: ${qrl.getChannelId()})`, 'info');
    updateStatus(ConnectionStatus.WAITING);
  } catch (err) {
    // The old channel is already torn down: hide the stale QR / deep-link /
    // copy affordances so a dead URI cannot be scanned, opened, or copied.
    showDisconnectedUI();
    updateStatus(ConnectionStatus.DISCONNECTED);
    log(`Failed to regenerate QR: ${err.message}. Click the wallet again to retry.`, 'error');
  }
});

qrl.on('accountsChanged', (accounts) => {
  if (activeProvider !== qrl) return;
  log(`Accounts: ${accounts.join(', ')}`, 'success');
  showConnectedUI(accounts, activeProviderInfo);
});

qrl.on('chainChanged', (chainId) => {
  if (activeProvider !== qrl) return;
  log(`Chain changed: ${chainId}`, 'info');
});

qrl.on('statusChanged', (status) => {
  if (activeProvider !== qrl) return;
  updateStatus(status);
});

// ─── QR rendering helper ─────────────────────────────────
async function showQR(uri) {
  qrContainer.classList.remove('hidden');
  await QRCode.toCanvas(qrCanvas, uri, {
    width: 280,
    margin: 2,
    color: { dark: '#000000', light: '#ffffff' },
  });
  uriDisplay.textContent = uri;
  uriDisplay.classList.remove('hidden');
  // Desktop browsers: offer the qrlconnect:// protocol-handler deep link
  // (opens the MyQRLWallet desktop app if installed) plus a copy button for
  // the wallet's paste-code fallback. Mobile already auto-deep-links.
  btnOpenDesktop.href = uri;
  if (!qrl.isMobile()) desktopActions.classList.remove('hidden');
}

// ─── Mobile deep link helper ─────────────────────────────
//
// Resolves true when something handled the qrlconnect:// navigation (the
// page went hidden, so the wallet app opened) and false when the page is
// still visible after the timeout: app not installed (silent failure on
// Android, blocking alert on iOS) or the user dismissed the OS chooser.
// Callers must treat false as "show fallback pairing UI", not as proof
// the app is absent. Mirrors attemptWalletRedirect in the SDK.
const APP_STORE_URL = getAppStoreUrl();

function tryOpenMobileDeepLink(uri, sourceLabel) {
  if (!qrl.isMobile()) return Promise.resolve(false);

  log(`[Mobile] Deep link attempt (${sourceLabel})`, 'info');
  log(`[Mobile] URI: ${uri}`, 'info');

  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (opened) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', onPageHide);
      clearTimeout(timer);
      resolve(opened);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        log('[Mobile] Page hidden after deep link attempt (wallet opened)', 'success');
        finish(true);
      }
    };
    const onPageHide = () => {
      log('[Mobile] Page backgrounded after deep link attempt', 'success');
      finish(true);
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', onPageHide);

    timer = setTimeout(() => {
      log(`[Mobile] Nothing handled the deep link. Wallet app not installed? Get MyQRLWallet: ${APP_STORE_URL}`, 'error');
      finish(false);
    }, 1800);

    window.location.href = uri;
  });
}

// Fallback pairing UI for a failed mobile deep link: the copy-code actions
// (normally desktop-only) plus the connection URI, so the user can install
// the app or pair via the wallet at qrlwallet.com with the copied code.
async function showMobileFallback(uri) {
  await showQR(uri);
  desktopActions.classList.remove('hidden');
}

// Track which extension providers we've already wired EIP-1193 listeners to,
// so reconnecting via the picker doesn't stack duplicate handlers.
const wiredProviders = new WeakSet();

function wireExtensionProviderEvents(detail) {
  if (typeof detail.provider.on !== 'function') return;
  if (wiredProviders.has(detail.provider)) return;
  wiredProviders.add(detail.provider);

  detail.provider.on('accountsChanged', (newAccounts) => {
    if (activeProvider !== detail.provider) return;
    log(`[ext] accountsChanged: ${newAccounts.join(', ')}`, 'info');
    if (newAccounts.length === 0) {
      showDisconnectedUI();
      setStatus('red', 'Disconnected');
    } else {
      showConnectedUI(newAccounts, detail.info);
    }
  });
  detail.provider.on('chainChanged', (chainId) => {
    if (activeProvider !== detail.provider) return;
    log(`[ext] chainChanged: ${chainId}`, 'info');
  });
}

// ─── Connect dispatch ────────────────────────────────────
async function connectWith(detail) {
  hidePicker();
  if (detail.info.rdns === QRL_CONNECT_RDNS) {
    await connectViaRelay(detail);
  } else {
    await connectViaExtension(detail);
  }
}

async function connectViaRelay(detail) {
  activeProvider = qrl;
  activeProviderInfo = detail.info;
  log('Creating connection via QRL Connect (mobile)...', 'info');
  try {
    const uri = await qrl.getConnectionURI();
    log(`Connection URI generated (channel: ${qrl.getChannelId()})`, 'info');
    if (qrl.isMobile()) {
      const opened = await tryOpenMobileDeepLink(uri, 'connect');
      if (!opened) await showMobileFallback(uri);
    } else {
      await showQR(uri);
    }
    updateStatus(ConnectionStatus.WAITING);
  } catch (err) {
    log(`Connection error: ${err.message}`, 'error');
    showDisconnectedUI();
  }
}

async function connectViaExtension(detail) {
  activeProvider = detail.provider;
  activeProviderInfo = detail.info;
  const walletName = detail.info.name;
  log(`Requesting accounts from ${walletName}...`, 'info');
  setStatus('yellow', `Waiting for ${walletName} approval...`);

  // Some extensions (incl. QRL Web3 Wallet on MV3) silently swallow
  // `browser.action.openPopup()` failures and the request just hangs while
  // the user has no idea a popup was attempted. Surface a hint after 3s so
  // the user knows to click the toolbar icon manually.
  const hintTimer = setTimeout(() => {
    log(
      `If no approval window appeared, click the ${walletName} icon in your browser toolbar to approve the connection.`,
      'info',
    );
    setStatus('yellow', `Approve in ${walletName} (toolbar icon)`);
  }, 3000);

  try {
    const accounts = await detail.provider.request({ method: 'qrl_requestAccounts' });
    clearTimeout(hintTimer);
    if (!accounts || accounts.length === 0) {
      log('Extension returned no accounts', 'error');
      setStatus('red', 'No accounts returned');
      showDisconnectedUI();
      return;
    }
    log(`Connected via ${walletName}: ${accounts.join(', ')}`, 'success');
    setStatus('green', `Connected via ${walletName}`);
    showConnectedUI(accounts, detail.info);

    // Wire EIP-1193 events once per provider: extension provider objects are
    // long-lived singletons, so re-wiring on every connect would stack
    // duplicate handlers and produce duplicate log lines on each event.
    wireExtensionProviderEvents(detail);
  } catch (err) {
    clearTimeout(hintTimer);
    const code = err?.code;
    if (code === 4001) {
      log(`${walletName}: connection request rejected by user.`, 'error');
      setStatus('red', 'Rejected');
    } else {
      log(`${walletName} connect failed: ${err.message ?? err}`, 'error');
      setStatus('red', 'Connect failed');
    }
    showDisconnectedUI();
  }
}

// ─── Switch wallet (re-open picker) ──────────────────────
btnSwitchWallet.addEventListener('click', async () => {
  if (activeProvider === qrl) {
    userDisconnected = true;
    await qrl.disconnect();
  }
  showDisconnectedUI();
  updateStatus(ConnectionStatus.DISCONNECTED);
});

// ─── New Connection (relay-only, fresh channel) ──────────
btnNewConn.addEventListener('click', async () => {
  if (activeProvider !== qrl) return;
  btnNewConn.disabled = true;
  btnNewConn.textContent = 'Generating...';
  log('Creating new connection (resetting existing session)...', 'info');

  try {
    const uri = await qrl.newConnection();
    log(`New connection URI generated (channel: ${qrl.getChannelId()})`, 'info');
    accountInfo.classList.add('hidden');
    btnDisconnect.classList.add('hidden');
    btnSend.disabled = true;
    btnSign.disabled = true;
    btnSignTyped.disabled = true;
    btnRpc.disabled = true;
    if (qrl.isMobile()) {
      const opened = await tryOpenMobileDeepLink(uri, 'newConnection');
      if (!opened) await showMobileFallback(uri);
    } else {
      await showQR(uri);
    }
    btnNewConn.textContent = 'New Connection';
    btnNewConn.disabled = false;
    updateStatus(ConnectionStatus.WAITING);
  } catch (err) {
    log(`New connection error: ${err.message}`, 'error');
    btnNewConn.textContent = 'New Connection';
    btnNewConn.disabled = false;
  }
});

// ─── Disconnect ──────────────────────────────────────────
btnDisconnect.addEventListener('click', async () => {
  if (activeProvider === qrl) {
    userDisconnected = true;
    await qrl.disconnect();
  }
  log('Disconnected', 'info');
  updateStatus(ConnectionStatus.DISCONNECTED);
  showDisconnectedUI();
});

// ─── Desktop wallet actions (deep link + copy) ───────────
// The anchor's href is the qrlconnect:// URI; the OS protocol handler opens
// the MyQRLWallet desktop app (if installed), which stages the URI behind a
// consent modal. The browser stays on this page (no navigation happens).
btnOpenDesktop.addEventListener('click', () => {
  log('[Desktop] Opening in MyQRLWallet via qrlconnect:// protocol handler...', 'info');
  log('[Desktop] Nothing happened? Install the desktop wallet, or copy the code and paste it under dApp Sessions.', 'info');
});

// Static label + a single cleared timeout: capturing textContent after the
// await races overlapping clicks and can stick the button on 'Copied!'.
const COPY_URI_LABEL = 'Copy connection code';
let copyUriResetTimer = null;
btnCopyUri.addEventListener('click', async () => {
  const uri = btnOpenDesktop.getAttribute('href') || '';
  if (!uri.startsWith('qrlconnect:')) return;
  try {
    await navigator.clipboard.writeText(uri);
    btnCopyUri.textContent = 'Copied!';
    clearTimeout(copyUriResetTimer);
    copyUriResetTimer = setTimeout(() => {
      btnCopyUri.textContent = COPY_URI_LABEL;
    }, 1500);
    log('[Desktop] Connection code copied. Paste it in the wallet under Settings > dApp Sessions.', 'success');
  } catch (err) {
    log(`[Desktop] Copy failed (${err.message}). Select the code text above and copy manually.`, 'error');
  }
});

// ─── Send Transaction ────────────────────────────────────
btnSend.addEventListener('click', async () => {
  const to = $('tx-to').value.trim();
  const qrlAmount = $('tx-value').value.trim();

  if (!to) { log('Enter a recipient address', 'error'); return; }
  if (!qrlAmount || isNaN(Number(qrlAmount)) || Number(qrlAmount) < 0) { log('Enter a valid non-negative amount', 'error'); return; }

  const weiValue = BigInt(Math.floor(Number(qrlAmount) * 1e18));

  btnSend.disabled = true;
  btnSend.textContent = 'Waiting for approval...';
  txResult.classList.add('hidden');
  log(`Sending ${qrlAmount} QRL to ${to}...`, 'info');

  try {
    // The two transports need different tx shapes. The relay wallet
    // estimates gas itself, so it gets the minimal hex shape. The extension
    // feeds the dApp's fields straight into web3 signTransaction: it needs
    // a numeric gas limit under both keys, a decimal-string value, and
    // type "0x2" (its legacy gasPrice branch fails web3 gas validation).
    // Shape device-verified on quantaswap.io, 2026-07-09.
    let txParams;
    if (QRL_EXTENSION_RDNS.has(activeProviderInfo?.rdns)) {
      let gasLimit = 100000;
      try {
        const estimated = await activeProvider.request({
          method: 'qrl_estimateGas',
          params: [{ from: connectedAccount, to, value: '0x' + weiValue.toString(16) }],
        });
        gasLimit = Number((BigInt(estimated) * 130n) / 100n);
      } catch {
        // estimation is best-effort; the fallback covers native transfers
      }
      txParams = {
        from: connectedAccount,
        to,
        value: weiValue.toString(),
        gas: gasLimit,
        gasLimit,
        type: '0x2',
      };
    } else {
      txParams = {
        from: connectedAccount,
        to,
        value: '0x' + weiValue.toString(16),
      };
    }

    const txHash = await activeProvider.request({
      method: 'qrl_sendTransaction',
      params: [txParams],
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

// ─── Sign helpers ────────────────────────────────────────
const SHORT_HEX = (s) => (typeof s === 'string' && s.length > 24 ? `${s.slice(0, 12)}...${s.slice(-8)}` : s);

function renderSignResultCard(box, result, verifyOk) {
  box.replaceChildren();
  box.style.whiteSpace = 'pre-wrap';
  const lines = [
    `${verifyOk ? '✓ verified locally' : '✗ LOCAL VERIFY FAILED'}`,
    `schemeVersion : ${result.schemeVersion}`,
    `signer        : ${result.signer}`,
    `digest        : ${SHORT_HEX(result.digest)}`,
    `publicKey     : ${SHORT_HEX(result.publicKey)}`,
    `signature     : ${SHORT_HEX(result.signature)}`,
  ];
  if (result.domain) {
    lines.push(`domain        : ${JSON.stringify(result.domain)}`);
  }
  box.textContent = lines.join('\n');
  box.classList.remove('hidden');
}

// ─── Sign Message (qrl_signMessage v1) ───────────────────
btnSign.addEventListener('click', async () => {
  const message = $('sign-message').value.trim();
  if (!message) { log('Enter a message to sign', 'error'); return; }

  btnSign.disabled = true;
  btnSign.textContent = 'Waiting for approval...';
  signResult.classList.add('hidden');
  log(`Requesting qrl_signMessage for: "${message}"`, 'info');

  // params[1] is strict 0x-hex bytes; the dApp UTF-8-encodes here so the
  // wallet receives a single canonical form.
  const messageHex = bytesToHex(new TextEncoder().encode(message));

  try {
    const result = await activeProvider.request({
      method: 'qrl_signMessage',
      params: [connectedAccount, messageHex],
    });
    log('Wallet returned a signed-message response', 'success');

    const ok = verifyMessage({
      signature: result.signature,
      publicKey: result.publicKey,
      messageBytes: messageHex,
    });
    log(`Local verifyMessage(): ${ok ? 'OK' : 'FAILED'}`, ok ? 'success' : 'error');
    renderSignResultCard(signResult, result, ok);
  } catch (err) {
    log(`qrl_signMessage failed: ${err.message}`, 'error');
    signResult.textContent = `Error: ${err.message}`;
    signResult.classList.remove('hidden');
  } finally {
    btnSign.disabled = false;
    btnSign.textContent = 'Sign Message';
  }
});

// ─── Sign Typed Data (qrl_signTypedData v1) ──────────────
function defaultTypedPayload() {
  // A realistic QuantaPool example: an off-chain, gasless "stake intent" that
  // authorizes the pool to stake `qrlAmount` of QRL for stQRL liquid-staking
  // shares (with a slippage floor), bound to the QuantaPool DepositPoolV2
  // domain. nonce + deadline give it replay protection, exactly what a real
  // protocol relayer would later honor on-chain.
  return {
    types: {
      QRLDomain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      StakeIntent: [
        { name: 'staker', type: 'address' },
        { name: 'qrlAmount', type: 'uint256' },
        { name: 'minShares', type: 'uint256' },
        { name: 'referrer', type: 'address' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint64' },
      ],
    },
    primaryType: 'StakeIntent',
    domain: {
      name: 'QuantaPool',
      version: '1',
      chainId: '1337',
      // DepositPoolV2 (placeholder; set to the deployed pool address)
      verifyingContract: 'Q0000000000000000000000000000000000000000',
    },
    message: {
      staker: connectedAccount || '',
      qrlAmount: '100000000000000000000', // 100 QRL (in planck)
      minShares: '98500000000000000000', // >= 98.5 stQRL (1.5% slippage floor)
      referrer: 'Q0000000000000000000000000000000000000000', // zero = none
      nonce: '0',
      deadline: String(Math.floor(Date.now() / 1000) + 3600), // valid for 1h
    },
  };
}

function refreshTypedPlaceholder() {
  signTypedInput.value = JSON.stringify(defaultTypedPayload(), null, 2);
}
refreshTypedPlaceholder();

// Track manual edits so refreshing on connect never clobbers them.
signTypedInput.addEventListener('input', () => { typedEdited = true; });

btnSignTyped.addEventListener('click', async () => {
  let payload;
  try {
    payload = JSON.parse(signTypedInput.value);
  } catch (e) {
    log(`Typed-data payload is not valid JSON: ${e.message}`, 'error');
    return;
  }
  // Auto-fill the staker with the connected account if left blank
  if (payload?.message && !payload.message.staker) {
    payload.message.staker = connectedAccount;
  }

  btnSignTyped.disabled = true;
  btnSignTyped.textContent = 'Waiting for approval...';
  signTypedResult.classList.add('hidden');
  log(`Requesting qrl_signTypedData (primary=${payload.primaryType})`, 'info');

  try {
    const result = await activeProvider.request({
      method: 'qrl_signTypedData',
      params: [connectedAccount, payload],
    });
    log('Wallet returned a signed typed-data response', 'success');

    const ok = verifyTypedData({
      signature: result.signature,
      publicKey: result.publicKey,
      payload,
    });
    log(`Local verifyTypedData(): ${ok ? 'OK' : 'FAILED'}`, ok ? 'success' : 'error');
    renderSignResultCard(signTypedResult, result, ok);
  } catch (err) {
    log(`qrl_signTypedData failed: ${err.message}`, 'error');
    signTypedResult.textContent = `Error: ${err.message}`;
    signTypedResult.classList.remove('hidden');
  } finally {
    btnSignTyped.disabled = false;
    btnSignTyped.textContent = 'Sign Typed Data';
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
    const result = await activeProvider.request({ method, params });
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

// Auto-reconnect to a stored relay session if one is present.
//
// hasStoredSession() is presence-only (a saved localStorage record within
// its TTL), NOT proof the wallet is still reachable. The SDK's reconnect()
// (fired in the QRLConnect constructor) bounds the wait: it reads the relay
// participant roster, and if no wallet re-appears within its probe window it
// surfaces a 'disconnect', which our handler above turns into a fresh QR.
// So phrase this tentatively rather than asserting a reconnection.
if (qrl.hasStoredSession()) {
  log('Found a saved session, checking if your wallet is still reachable...', 'info');
  activeProvider = qrl;
  activeProviderInfo = {
    name: QRL_CONNECT_PROVIDER_INFO.name,
    rdns: QRL_CONNECT_RDNS,
  };
  hidePicker();
  // Reflect the SDK's actual current status. reconnect() already ran in the
  // constructor (before our statusChanged listener was attached), so read it
  // directly instead of assuming RECONNECTING.
  updateStatus(qrl.getStatus());
} else {
  log('No stored session. Pick a wallet to start.', 'info');
}
