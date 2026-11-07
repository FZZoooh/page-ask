// 配置页（GET /settings）与 /api/settings* 的回归：外部文案、错误码、draft 测试、清空 Key、token 下的同源访问。
// 用临时 HOME / DATA_DIR + 假上游，不碰真实配置。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
      /* 还没起来 */
    }
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 120));
  }
}

// 假上游：只认正确的 Bearer，用来验证“测试连接”真的用了表单里的 Key
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
const child = spawn(process.execPath, ['server/index.mjs'], {
  cwd: root,
  env: {
    ...process.env,
    PAGEASK_DATA_DIR: dataDir,
    PAGEASK_PORT: String(port),
    PAGEASK_TOKEN: 'secret',
    HOME: home,
    USERPROFILE: home,
  },
  // 沙箱下管道 stdio 会 EPERM，这里不需要读子进程输出
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
    /* HTML 或纯文本 */
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
  check('后端启动', () => assert.ok(up));

  // 1. 页面由外部字典渲染；Accept-Language 不匹配时回退 zh-CN
  const page = await request('/settings', { headers: { 'Accept-Language': 'en-US,en;q=0.9' } });
  check('配置页 200', () => assert.equal(page.status, 200));
  check('html lang 回退 zh-CN', () => assert.match(page.raw, /<html lang="zh-CN">/));
  check('标题来自字典', () => assert.ok(page.raw.includes('PageAsk 配置')));
  check('页面没有空占位', () => assert.ok(!page.raw.includes('>undefined<') && !page.raw.includes('>null<')));
  check('客户端拿到整份字典', () => assert.ok(page.raw.includes('"webui.saved"')));
  check('客户端拿到错误码文案', () => assert.ok(page.raw.includes('"error.settings.invalid_state"')));

  // 2. 错误码：非法 state / 非法 baseUrl
  const badState = await postJson('/api/settings', { state: 'maybe' }, { Origin: sameOrigin });
  check('非法 state 返回 400', () => assert.equal(badState.status, 400));
  check('非法 state 的错误码', () => assert.equal(badState.body?.code, 'settings.invalid_state'));
  check('非法 state 的文案带可选值', () => assert.match(badState.body?.error ?? '', /auto \/ on \/ off/));

  const badUrl = await postJson('/api/settings', { baseUrl: 'ftp://example.com' }, { Origin: sameOrigin });
  check('非法 baseUrl 返回 400', () => assert.equal(badUrl.status, 400));
  check('非法 baseUrl 的错误码', () => assert.equal(badUrl.body?.code, 'settings.invalid_base_url'));

  // 3. 保存、掩码、draft 测试、清空
  const saved = await postJson(
    '/api/settings',
    { baseUrl: upstreamBase, model: 'fake-model', state: 'off', apiKey: KEY },
    { Origin: sameOrigin },
  );
  check('保存成功', () => assert.equal(saved.status, 200));
  check('保存后 hasKey', () => assert.equal(saved.body?.hasKey, true));
  check('不回传明文 Key', () => assert.ok(!JSON.stringify(saved.body).includes(KEY)));
  check('状态已保存', () => assert.equal(saved.body?.state, 'off'));

  const draftTest = await postJson(
    '/api/settings/test',
    { baseUrl: upstreamBase, model: 'fake-model' },
    { Origin: sameOrigin },
  );
  check('测试连接使用已保存的 Key', () => assert.equal(draftTest.body?.ok, true));
  check('测试连接带状态码', () => assert.equal(draftTest.body?.status, 200));

  const wrongKey = await postJson(
    '/api/settings/test',
    { baseUrl: upstreamBase, apiKey: 'sk-wrong-key-000' },
    { Origin: sameOrigin },
  );
  check('测试连接使用表单里的 Key', () => assert.equal(wrongKey.body?.ok, false));
  check('错误 Key 的状态码', () => assert.equal(wrongKey.body?.status, 401));

  const cleared = await postJson('/api/settings', { clearApiKey: true }, { Origin: sameOrigin });
  check('清空 Key 成功', () => assert.equal(cleared.status, 200));
  check('清空后 hasKey=false', () => assert.equal(cleared.body?.hasKey, false));

  const noKeyTest = await postJson('/api/settings/test', {}, { Origin: sameOrigin });
  check('没有 Key 时测试给出错误码', () => assert.equal(noKeyTest.body?.code, 'settings.missing_api_key'));

  // 4. token 开启时：/api/settings 仍需同源或 token；/health 同源可读
  const anonSettings = await request('/api/settings');
  check('无 Origin 读配置 403', () => assert.equal(anonSettings.status, 403));

  const anonHealth = await request('/health');
  check('无 Origin 读 /health 401', () => assert.equal(anonHealth.status, 401));

  const sameHealth = await request('/health', { headers: { Origin: sameOrigin } });
  check('同源读 /health 200', () => assert.equal(sameHealth.status, 200));
  check('/health 返回模型', () => assert.ok(sameHealth.body?.model));

  const tokenHealth = await request('/health', { headers: { Authorization: 'Bearer secret' } });
  check('带 token 读 /health 200', () => assert.equal(tokenHealth.status, 200));
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
  console.error(`${failures} 项失败`);
  process.exitCode = 1;
} else {
  console.log('全部通过');
}
