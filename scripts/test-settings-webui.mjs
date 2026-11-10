// Regression for the settings page (GET /settings) and /api/settings*: externalized copy, error codes,
// draft tests, clearing the key, and same-origin access when a token is set.
// Uses a temporary HOME / DATA_DIR plus a fake upstream, never touching real config.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import zhCN from '../server/i18n/zh-CN.mjs';
import enXA from '../server/i18n/en-XA.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temp = mkdtempSync(join(tmpdir(), 'pageask-webui-'));
const dataDir = join(temp, 'data');
const home = join(temp, 'home');
const KEY = 'sk-test-1234567890';
let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}: ${err?.message ?? err}`);
  }
}

async function freePort() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = srv.address().port;
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

async function waitFor(fn, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await fn()) return true;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 120));
  }
}

// Fake upstream: accepts only the correct Bearer, proving "test connection" really uses the form key
const upstream = http.createServer((req, res) => {
  if (req.url !== '/v1/models') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
    return;
  }
  if (req.headers.authorization !== `Bearer ${KEY}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'bad key' } }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
});

const upstreamPort = await freePort();
await new Promise((resolve) => upstream.listen(upstreamPort, '127.0.0.1', resolve));
const upstreamBase = `http://127.0.0.1:${upstreamPort}`;

const port = await freePort();
// No environment variables: the isolated home's settings.json is the only config the child sees.
mkdirSync(join(home, '.config', 'righthandman'), { recursive: true });
writeFileSync(
  join(home, '.config', 'righthandman', 'settings.json'),
  JSON.stringify({
    baseUrl: upstreamBase,
    model: 'fake-model',
    apiKey: KEY,
    state: 'auto',
    port,
    token: 'secret',
    dataDir,
  }),
);
const child = spawn(process.execPath, ['server/index.mjs'], {
  cwd: root,
  env: { ...process.env, HOME: home, USERPROFILE: home },
  // Piped stdio hits EPERM under the sandbox, and we never read the child's output anyway
  stdio: 'ignore',
});

const sameOrigin = `http://127.0.0.1:${port}`;

async function request(path, init = {}) {
  const res = await fetch(`${sameOrigin}${path}`, init);
  const raw = await res.text();
  let body = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    /* HTML or plain text */
  }
  return { status: res.status, body, raw };
}

function postJson(path, body, headers = {}) {
  return request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

try {
  const up = await waitFor(async () => (await fetch(`${sameOrigin}/health/live`)).ok);
  check('backend started', () => assert.ok(up));

  // 1. The page renders from an external dictionary; Accept-Language picks the locale,
  //    and a non-matching language falls back to zh-CN
  const enPage = await request('/settings', { headers: { 'Accept-Language': 'en-US,en;q=0.9' } });
  check('en-US settings page returns 200', () => assert.equal(enPage.status, 200));
  check('Accept-Language selects en-US', () => assert.match(enPage.raw, /<html lang="en-US">/));
  check('the English title comes from the dictionary', () => assert.ok(enPage.raw.includes('RightHandMan Settings')));
  check('the English page has no empty placeholders', () => assert.ok(!enPage.raw.includes('>undefined<') && !enPage.raw.includes('>null<')));
  check('the English client receives the whole dictionary', () => assert.ok(enPage.raw.includes('"webui.saved"') && enPage.raw.includes('"Saved"')));

  const page = await request('/settings');
  check('settings page returns 200', () => assert.equal(page.status, 200));
  check('html lang defaults to zh-CN', () => assert.match(page.raw, /<html lang="zh-CN">/));
  check('title comes from the dictionary', () => assert.ok(page.raw.includes('RightHandMan 配置')));
  check('the page has no empty placeholders', () => assert.ok(!page.raw.includes('>undefined<') && !page.raw.includes('>null<')));
  check('client receives the whole dictionary', () => assert.ok(page.raw.includes('"webui.saved"')));
  check('client receives the error-code strings', () => assert.ok(page.raw.includes('"error.settings.invalid_state"')));

  // 1a. ?lang= wins over Accept-Language; an unsupported language falls back to the default
  const forcedEn = await request('/settings?lang=en-US', { headers: { 'Accept-Language': 'zh-CN' } });
  check('?lang=en-US overrides Accept-Language', () => assert.match(forcedEn.raw, /<html lang="en-US">/));
  const unsupported = await request('/settings?lang=fr-FR');
  check('an unsupported language falls back to zh-CN', () => assert.match(unsupported.raw, /<html lang="zh-CN">/));

  // 1b. Pseudo-localization: ?lang=en-XA reuses the same dictionary, its text is markedly longer,
  //     so layout problems are visible by eye or in a screenshot
  const pseudo = await request('/settings?lang=en-XA');
  check('en-XA settings page returns 200', () => assert.equal(pseudo.status, 200));
  check('en-XA html lang', () => assert.match(pseudo.raw, /<html lang="en-XA">/));
  check('en-XA uses pseudo copy', () => assert.ok(pseudo.raw.includes('[!!') && pseudo.raw.includes('RightHandMan')));
  check('en-XA lengthens every key', () => {
    // Whole-page length can pass while one long dictionary value stayed untranslated.
    for (const [key, value] of Object.entries(zhCN)) {
      assert.ok(Object.hasOwn(enXA, key), `en-XA is missing ${key}`);
      assert.ok(enXA[key].length > value.length, `${key} is not pseudo-localized`);
    }
  });

  // 1c. The config path is a button that asks the backend to open the file (a file:// link cannot
  //     work from an http page). Opening it is a settings write: same origin or the token, like save.
  check('the settings page has a clickable config path', () => assert.ok(page.raw.includes('id="file"')));

  const getOpen = await request('/api/settings/open', {
    headers: { Origin: sameOrigin, Authorization: 'Bearer secret' },
  });
  check('GET on open-config returns 404', () => assert.equal(getOpen.status, 404));

  const anonOpen = await postJson('/api/settings/open', {});
  check('opening the config file without Origin returns 403', () => assert.equal(anonOpen.status, 403));
  check('the open-config error code', () => assert.equal(anonOpen.body?.code, 'auth.forbidden'));

  // 2. Error codes: invalid state / invalid baseUrl
  const badState = await postJson('/api/settings', { state: 'maybe' }, { Origin: sameOrigin });
  check('an invalid state returns 400', () => assert.equal(badState.status, 400));
  check('the invalid-state error code', () => assert.equal(badState.body?.code, 'settings.invalid_state'));
  check('the invalid-state copy lists the allowed values', () => assert.match(badState.body?.error ?? '', /auto \/ on \/ off/));

  const badUrl = await postJson('/api/settings', { baseUrl: 'ftp://example.com' }, { Origin: sameOrigin });
  check('an invalid baseUrl returns 400', () => assert.equal(badUrl.status, 400));
  check('the invalid-baseUrl error code', () => assert.equal(badUrl.body?.code, 'settings.invalid_base_url'));

  // 3. Save, masking, draft test, clear
  const saved = await postJson(
    '/api/settings',
    { baseUrl: upstreamBase, model: 'fake-model', state: 'off', apiKey: KEY },
    { Origin: sameOrigin },
  );
  check('save succeeds', () => assert.equal(saved.status, 200));
  check('hasKey after saving', () => assert.equal(saved.body?.hasKey, true));
  check('the key never comes back in plaintext', () => assert.ok(!JSON.stringify(saved.body).includes(KEY)));
  check('the state is saved', () => assert.equal(saved.body?.state, 'off'));

  const draftTest = await postJson(
    '/api/settings/test',
    { baseUrl: upstreamBase, model: 'fake-model' },
    { Origin: sameOrigin },
  );
  check('the connection test uses the stored key', () => assert.equal(draftTest.body?.ok, true));
  check('the connection test returns a status', () => assert.equal(draftTest.body?.status, 200));

  const changedUrlNoKey = await postJson(
    '/api/settings/test',
    { baseUrl: 'http://127.0.0.1:9' },
    { Origin: sameOrigin },
  );
  check('changing the base URL needs no key re-entry', () => assert.equal(changedUrlNoKey.status, 200));
  check('an unreachable address fails the test', () => assert.equal(changedUrlNoKey.body?.code, 'settings.test_failed'));

  const wrongKey = await postJson(
    '/api/settings/test',
    { baseUrl: upstreamBase, apiKey: 'sk-wrong-key-000' },
    { Origin: sameOrigin },
  );
  check('the connection test uses the key from the form', () => assert.equal(wrongKey.body?.ok, false));
  check('the wrong key yields the upstream status', () => assert.equal(wrongKey.body?.status, 401));

  const cleared = await postJson('/api/settings', { clearApiKey: true }, { Origin: sameOrigin });
  check('clearing the key succeeds', () => assert.equal(cleared.status, 200));
  check('hasKey=false after clearing', () => assert.equal(cleared.body?.hasKey, false));

  const noKeyTest = await postJson('/api/settings/test', {}, { Origin: sameOrigin });
  check('a missing key yields an error code', () => assert.equal(noKeyTest.body?.code, 'settings.missing_api_key'));

  // 4. With a token set: /api/settings still needs same origin or the token; /health reads same-origin
  const anonSettings = await request('/api/settings');
  check('reading settings without Origin returns 403', () => assert.equal(anonSettings.status, 403));

  const anonHealth = await request('/health');
  check('reading /health without Origin returns 401', () => assert.equal(anonHealth.status, 401));

  const sameHealth = await request('/health', { headers: { Origin: sameOrigin } });
  check('same-origin /health returns 200', () => assert.equal(sameHealth.status, 200));
  check('/health returns the model', () => assert.ok(sameHealth.body?.model));

  const tokenHealth = await request('/health', { headers: { Authorization: 'Bearer secret' } });
  check('/health with the token returns 200', () => assert.equal(tokenHealth.status, 200));
} finally {
  child.kill();
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(resolve, 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  upstream.closeAllConnections?.();
  await new Promise((resolve) => upstream.close(resolve));
  for (let i = 0; i < 5; i += 1) {
    try {
      rmSync(temp, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exitCode = 1;
} else {
  console.log('all good');
}
