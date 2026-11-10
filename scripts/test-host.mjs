// Regression: a DNS-rebinding page reaches the loopback port with its own Host header, and malformed
// conversation ids must be a 400 contract error rather than a top-level 500. Run:
// node scripts/test-host.mjs
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = mkdtempSync(join(tmpdir(), 'pageask-host-home-'));
const data = mkdtempSync(join(tmpdir(), 'pageask-host-data-'));
mkdirSync(join(home, '.config', 'righthandman'), { recursive: true });

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !extra ? '' : ` — ${extra}`}`);
  if (!ok) failures += 1;
};

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });

const port = await freePort();
writeFileSync(
  join(home, '.config', 'righthandman', 'settings.json'),
  JSON.stringify({
    baseUrl: 'http://127.0.0.1:1',
    model: 'fake',
    apiKey: 'test-key',
    state: 'off',
    port,
    token: '',
    dataDir: data,
  }),
);

const child = spawn(process.execPath, [join(root, 'server', 'index.mjs')], {
  env: { ...process.env, USERPROFILE: home, HOME: home },
  stdio: 'ignore',
});

const get = (host, path) =>
  new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, headers: { Host: host } }, (res) => {
      let body = '';
      res.on('data', (c) => {
        body += c;
      });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });

const waitUp = async () => {
  for (let i = 0; i < 80; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health/live`);
      if (r.ok) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

try {
  check('backend started', await waitUp());

  const evil = await get('rebind.example', '/health/live');
  check('unknown Host returns 403', evil.status === 403, `${evil.status} ${evil.body}`);
  check('unknown Host carries code request.bad_host', JSON.parse(evil.body).code === 'request.bad_host', evil.body);

  const loop = await get(`127.0.0.1:${port}`, '/health/live');
  check('127.0.0.1 Host is allowed', loop.status === 200, `${loop.status} ${loop.body}`);

  const local = await get(`localhost:${port}`, '/health/live');
  check('localhost Host is allowed', local.status === 200, `${local.status} ${local.body}`);

  const badId = await get(`127.0.0.1:${port}`, '/conversations/%E0%A4%A');
  check('malformed conversation id returns 400', badId.status === 400, `${badId.status} ${badId.body}`);
  check('malformed conversation id carries code request.bad_id', JSON.parse(badId.body).code === 'request.bad_id', badId.body);
} finally {
  child.kill();
  await new Promise((r) => {
    if (child.exitCode !== null) return r();
    child.once('exit', r);
    setTimeout(r, 3000);
  });
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* Windows may hold the sqlite handle briefly; the temp dir is harmless */
  }
}

console.log(failures ? `\n${failures} failure(s)` : '\nall good');
process.exitCode = failures ? 1 : 0;
