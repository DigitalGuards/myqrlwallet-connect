// Real-extension regression test. See ui/README.md for fixture configuration.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium, expect } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright/test');
assert.ok(process.env.QRL_EXTENSION_DIR, 'Set QRL_EXTENSION_DIR to an unpacked extension build');
const extensionDir = resolve(process.env.QRL_EXTENSION_DIR);
const sourceDir = resolve(process.env.QRL_EXTENSION_SOURCE ?? dirname(extensionDir));
const dist = resolve(fileURLToPath(new URL('../example/dist/', import.meta.url)));
const fixture = await readFile(join(sourceDir, 'e2e/bfcacheProvider.spec.ts'), 'utf8');
const seed = fixture.match(/const TEST_ONLY_HEX_SEED =\s*"([^"]+)"/u)?.[1];
const account = fixture.match(/const CHECKSUM_ACCOUNT =\s*"([^"]+)"/u)?.[1];
assert.ok(seed && account, 'The extension checkout must include its public E2E account fixture');
const genesis = '0xd15407991193e6c23b733dc6bf9c628deaff8f9b6e252aa0d60030952b3e3ea4';
const prefix = `v3:0x301825:${genesis}:`;
const password = 'extension-session-public-fixture';
const rpcResult = (method) =>
  ({
    qrl_getBlockByNumber: { hash: genesis },
    qrl_chainId: '0x301825',
    net_version: '3151909',
    net_listening: true,
    qrl_getBalance: '0x0',
    qrl_blockNumber: '0x1',
    web3_clientVersion: 'extension-session-fixture',
  })[method] ?? '0x0';

const server = createServer((req, res) => {
  void (async () => {
    if (req.url === '/rpc' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const requests = JSON.parse(body);
      const answer = (request) => ({
        jsonrpc: '2.0',
        id: request.id,
        result: rpcResult(request.method),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(Array.isArray(requests) ? requests.map(answer) : answer(requests)));
      return;
    }
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const path = resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!path.startsWith(dist + sep)) {
      res.writeHead(404);
      res.end();
      return;
    }
    const mime = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.svg': 'image/svg+xml',
    };
    const body = await readFile(path);
    res.writeHead(200, { 'Content-Type': mime[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  })().catch(() => {
    res.writeHead(404);
    res.end();
  });
});
await new Promise((resolve) => server.listen(0, 'localhost', resolve));
const address = server.address();
assert.ok(address && typeof address === 'object');
const origin = `http://localhost:${address.port}`;
const temp = await mkdtemp(join(tmpdir(), 'extension-session-'));
const reportPath = process.env.QRL_BROWSER_REPORT ?? join(temp, 'results.json');
const manifest = JSON.parse(await readFile(join(extensionDir, 'manifest.json'), 'utf8'));
const report = { extensionVersion: manifest.version, scenarios: [], pageErrors: [] };
function record(name, data = {}) {
  report.scenarios.push({ name, passed: true, ...data });
  console.log(`PASS ${name}`);
}

let context;
let extensionPage;
let page;
try {
  context = await chromium.launchPersistentContext(join(temp, 'profile'), {
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    headless: true,
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost',
    ],
  });
  context.setDefaultTimeout(25_000);
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extensionUrl = `chrome-extension://${new URL(worker.url()).host}/index.html?tab=true`;
  await worker.evaluate(
    async ({ prefix, origin }) => {
      await globalThis.chrome.storage.local.set({
        [`${prefix}SETTINGS`]: {
          sidePanelPreferred: true,
          phishingDetectionEnabled: false,
          autoLockMinutes: 30,
        },
        [`${prefix}BLOCKCHAINS`]: {
          ACTIVE_BLOCKCHAIN: '0x301825',
          ALL_BLOCKCHAINS: [
            {
              chainId: '0x301825',
              chainName: 'Session fixture',
              rpcUrls: [`${origin}/rpc`],
              blockExplorerUrls: ['https://example.invalid'],
              nativeCurrency: { name: 'Quanta', symbol: 'Quanta', decimals: 18 },
              iconUrls: [],
              defaultRpcUrl: `${origin}/rpc`,
              defaultBlockExplorerUrl: 'https://example.invalid',
              defaultIconUrl: '',
              isTestnet: true,
              defaultWsRpcUrl: `${origin}/rpc`,
              isCustomChain: true,
            },
          ],
        },
      });
    },
    { prefix, origin }
  );
  extensionPage = await context.newPage();
  await extensionPage.goto(extensionUrl);
  await extensionPage.getByRole('button', { name: 'Continue', exact: true }).click();
  await extensionPage.getByLabel('password', { exact: true }).fill(password);
  await extensionPage.getByLabel('reEnteredPassword').fill(password);
  await extensionPage.getByRole('button', { name: 'Continue', exact: true }).click();
  await extensionPage.getByRole('button', { name: 'Import an existing account' }).click();
  await extensionPage.getByRole('tab', { name: 'Hex seed' }).click();
  await extensionPage.getByRole('textbox', { name: 'hexSeed' }).fill(seed);
  await extensionPage.getByRole('button', { name: 'Import account', exact: true }).click();
  await extensionPage.getByRole('button', { name: 'Continue', exact: true }).click();
  await extensionPage.getByRole('heading', { name: "That's All" }).waitFor();
  const closed = extensionPage.waitForEvent('close');
  await extensionPage
    .getByRole('button', { name: 'Done', exact: true })
    .click()
    .catch((error) => {
      if (!extensionPage.isClosed()) throw error;
    });
  await closed;
  extensionPage = await context.newPage();
  await extensionPage.goto(extensionUrl);
  await extensionPage.getByRole('heading', { name: 'Active account' }).waitFor();
  const lock = async () => {
    await extensionPage.evaluate(() =>
      globalThis.chrome.runtime.sendMessage({ name: 'LOCK_MANAGER_LOCK' })
    );
    await extensionPage.getByRole('button', { name: 'Unlock', exact: true }).waitFor();
  };
  const unlock = async () => {
    await extensionPage.getByLabel('Enter password').fill(password);
    await extensionPage.getByRole('button', { name: 'Unlock', exact: true }).click();
    await extensionPage.getByRole('heading', { name: 'MyQRLWallet', exact: true }).waitFor({
      state: 'hidden',
    });
  };
  const grant = () =>
    worker.evaluate(
      async ({ key, origin }) =>
        (await globalThis.chrome.storage.local.get(key))[key]?.ALL_DAPPS?.[origin] ?? null,
      { key: `${prefix}DAPPS`, origin }
    );
  const pending = () =>
    worker.evaluate(
      async (key) =>
        (await globalThis.chrome.storage.session.get(key))[key]?.DAPPS_REQUEST_DATA?.method ?? null,
      `${prefix}DAPPS`
    );

  await lock();
  page = await context.newPage();
  page.on('pageerror', (error) => report.pageErrors.push(error.message));
  await page.addInitScript(() => {
    globalThis.__sessionEvents = [];
    globalThis.addEventListener('eip6963:announceProvider', (event) => {
      if (event.detail.info.rdns !== 'com.qrlwallet.extension' || globalThis.__sessionProvider)
        return;
      globalThis.__sessionProvider = event.detail.provider;
      for (const name of ['accountsChanged', 'chainChanged', 'disconnect']) {
        event.detail.provider.on(name, (value) => globalThis.__sessionEvents.push({ name, value }));
      }
    });
  });
  await page.goto(origin);
  const connect = () =>
    page.locator('#wallet-list button').filter({ hasText: 'Browser extension' }).first().click();
  const connected = async () => {
    await expect(page.locator('#account-info')).toBeVisible();
    await expect(page.locator('#status-text')).toContainText('Connected via');
    await expect(page.locator('#account-address')).toHaveAttribute('title', account);
    for (const id of ['btn-send', 'btn-sign', 'btn-sign-typed', 'btn-rpc']) {
      await expect(page.locator(`#${id}`)).toBeEnabled();
    }
  };
  const unavailable = async () => {
    await expect(page.locator('#account-info')).toBeHidden();
    await expect(page.locator('#status-text')).toContainText(
      'Wallet locked. Unlock to check access.'
    );
    for (const id of ['btn-send', 'btn-sign', 'btn-sign-typed', 'btn-rpc']) {
      await expect(page.locator(`#${id}`)).toBeDisabled();
    }
  };
  const disconnected = async () => {
    await expect(page.locator('#status-text')).toHaveText('Disconnected');
    await expect(page.locator('#account-info')).toBeHidden();
    for (const id of ['btn-send', 'btn-sign', 'btn-sign-typed', 'btn-rpc']) {
      await expect(page.locator(`#${id}`)).toBeDisabled();
    }
    assert.equal(
      await page.evaluate(() => globalThis.sessionStorage.getItem('qrlconnect:extension')),
      null
    );
  };
  const probeAccounts = () =>
    page.evaluate(async () => {
      try {
        return { accounts: await globalThis.__sessionProvider.request({ method: 'qrl_accounts' }) };
      } catch (error) {
        return { code: error.code };
      }
    });
  const approveRequest = async () => {
    await extensionPage.getByRole('button', { name: 'Yes', exact: true }).click();
    await expect.poll(pending).toBeNull();
  };
  const approve = async () => {
    await approveRequest();
    await connected();
  };

  await connect();
  await expect.poll(pending).toBe('qrl_requestAccounts');
  await expect(page.locator('#status-text')).toContainText('Unlock and approve');
  await expect(page.locator('#account-info')).toBeHidden();
  await unlock();
  await extensionPage.getByRole('button', { name: 'Yes', exact: true }).waitFor();
  await expect(page.locator('#account-info')).toBeHidden();
  await approve();
  assert.equal((await grant()).accounts[0], account);
  record('one Connect click while locked, unlock, then approve');

  await lock();
  await unavailable();
  assert.ok(await grant());
  await unlock();
  await connected();
  record('lock disables actions without revoking, unlock recovers without a click');

  await lock();
  await unavailable();
  await page.reload();
  await unavailable();
  assert.equal(await pending(), null);
  assert.ok(await grant());
  await unlock();
  await connected();
  record('reload while locked restores intent and recovers after unlock');

  await page.locator('#btn-disconnect').click();
  await expect.poll(grant).toBeNull();
  await disconnected();
  // Extension 1.3.0 denies this probe with 4100 when unlocked and ungranted.
  await expect.poll(probeAccounts).toEqual({ code: 4100 });
  await lock();
  await unlock();
  await extensionPage.getByRole('heading', { name: 'Active account' }).waitFor();
  await page.bringToFront();
  await extensionPage.locator('a[href="/dapp-connectivity"] button').click();
  await expect(extensionPage.getByText('Not Connected', { exact: true })).toBeVisible();
  await expect(extensionPage.getByRole('button', { name: 'Disconnect', exact: true })).toHaveCount(
    0
  );
  await extensionPage.getByRole('button', { name: 'Back', exact: true }).click();
  await extensionPage.getByRole('heading', { name: 'Active account' }).waitFor();
  await expect(page.locator('#account-info')).toBeHidden();
  await expect(page.locator('#btn-sign')).toBeDisabled();
  assert.equal(
    await page.evaluate(() => globalThis.sessionStorage.getItem('qrlconnect:extension')),
    null
  );
  record('page Disconnect removes grant and intent; unlock stays disconnected');

  await connect();
  await approve();
  await page.bringToFront();
  await extensionPage.locator('a[href="/dapp-connectivity"] button').click();
  await expect(extensionPage.getByText(origin, { exact: true })).toBeVisible();
  await extensionPage.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await extensionPage.getByRole('button', { name: 'Confirm Disconnect', exact: true }).click();
  await expect.poll(grant).toBeNull();
  await disconnected();
  await expect.poll(probeAccounts).toEqual({ code: 4100 });
  record('extension Disconnect while unlocked shows Disconnected and clears intent');

  await page.reload();
  await expect(
    page.locator('#wallet-list button').filter({ hasText: 'Browser extension' }).first()
  ).toBeVisible();
  await disconnected();
  await expect.poll(probeAccounts).toEqual({ code: 4100 });
  assert.equal(await pending(), null);
  record('reload after extension Disconnect shows Disconnected without an approval');

  // A saved selection can outlive a grant removed while the page was closed.
  await page.evaluate(() =>
    globalThis.sessionStorage.setItem('qrlconnect:extension', 'com.qrlwallet.extension')
  );
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => globalThis.sessionStorage.getItem('qrlconnect:extension')))
    .toBeNull();
  await disconnected();
  assert.equal(await pending(), null);
  record('reload with stale intent handles ungranted restore 4100 quietly');

  await connect();
  await approve();
  record('Connect after extension-side revocation requests approval again');
  await lock();
  await unavailable();
  await page.locator('#btn-disconnect').click();
  await expect.poll(grant).toBeNull();
  await expect(page.locator('#status-text')).toHaveText('Disconnected');
  record('page Disconnect revokes while the extension is locked');

  await connect();
  await expect.poll(pending).toBe('qrl_requestAccounts');
  await page.locator('#btn-disconnect').click();
  await disconnected();
  await expect.poll(grant).toBeNull();
  assert.equal(await pending(), 'qrl_requestAccounts');
  await unlock();
  await approveRequest();
  await expect.poll(probeAccounts).toEqual({ accounts: [account] });
  assert.equal((await grant()).accounts[0], account);
  await disconnected();
  const connectedOrigins = await worker.evaluate(
    async (key) =>
      Object.keys((await globalThis.chrome.storage.local.get(key))[key]?.ALL_DAPPS ?? {}),
    `${prefix}DAPPS`
  );
  assert.ok(connectedOrigins.includes(origin));
  await page.bringToFront();
  await extensionPage.locator('a[href="/dapp-connectivity"] button').click();
  await expect(extensionPage.getByText(origin, { exact: true })).toBeVisible();
  await disconnected();
  await connect();
  await connected();
  assert.equal(await pending(), null);
  await expect(extensionPage.getByRole('button', { name: 'Yes', exact: true })).toHaveCount(0);
  record(
    'Connect while locked, page Disconnect, late approval keeps the page Disconnected; later Connect reuses the grant without a prompt',
    {
      accountsProbe: { accounts: [account] },
      originInConnectedSites: true,
      pageStatusAfterApproval: 'Disconnected',
      pageStatusAfterConnect: 'Connected',
      pendingAfterConnect: null,
    }
  );

  assert.deepEqual(report.pageErrors, []);
} catch (error) {
  report.failure = String(error);
  console.error(error);
  for (const [label, target] of [
    ['extension', extensionPage],
    ['example', page],
  ]) {
    if (target && !target.isClosed()) {
      await writeFile(join(temp, `${label}-failure.txt`), await target.locator('body').innerText());
      await target.screenshot({ path: join(temp, `${label}-failure.png`) });
    }
  }
  process.exitCode = 1;
} finally {
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`Browser report: ${reportPath}`);
  await context?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(join(temp, 'profile'), { recursive: true, force: true });
}
