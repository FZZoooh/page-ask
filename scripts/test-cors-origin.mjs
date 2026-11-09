// Regression: foreign origins get a 403 before routing, while no-Origin local tools (curl/scripts)
// behave as documented. Run: node scripts/test-cors-origin.mjs
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTestConfig } from './temp-config.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cfg = makeTestConfig({ port: 0, token: 'secret-token' });
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !extra ? '' : ` — ${extra}`}`);
  if (!ok) failures += 1;
};

const port = await new Promise((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});
cfg.port = port;
const { writeFileSync } = await import('node:fs');
writeFileSync(
  cfg.settingsFile,
  `${JSON.stringify(
    {
      baseUrl: 'http://127.0.0.1:1',
      model: 'fake',
      apiKey: 'test-key',
      state: 'off',
      port,
      token: 'secret-token',
      dataDir: cfg.dataDir,
    },
    null,
    2,
  )}\n`,
);

const child = spawn(process.execPath, [join(root, 'server', 'index.mjs')], {
  env: { ...process.env, USERPROFILE: cfg.home, HOME: cfg.home },
  stdio: 'ignore',
});
const waitLive = async () => {
  for (let i = 0; i < 50; i += 1) {
    try {
      const r = await get('/health/live', {});
      if (r.status === 200) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};
const get = (path, headers) =>
  new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: cfg.port, path, headers }, (res) => {
      let body = '';
      res.on('data', (c) => {
        body += c;
      });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });

try {
  check('backend starts', await waitLive());
  const evil = await get('/health', { Origin: 'https://evil.example' });
  check('foreign Origin is rejected', evil.status === 403, String(evil.status));
  check('foreign Origin has a code', /auth\.origin|request\.bad_origin|auth\.forbidden/.test(evil.body), evil.body);

  const anon = await get('/health', {});
  check('no Origin without token is 401', anon.status === 401, String(anon.status));

  const same = await get('/health', { Origin: `http://127.0.0.1:${cfg.port}` });
  check('same-origin is allowed', same.status === 200, String(same.status));

  const preflight = await new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port: cfg.port,
        path: '/chat',
        method: 'OPTIONS',
        headers: {
          Origin: 'https://evil.example',
          'Access-Control-Request-Method': 'POST',
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      },
    );
    req.on('error', reject);
    req.end();
  });
  check('foreign preflight is rejected', preflight === 403, String(preflight));
} finally {
  child.kill();
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  cfg.cleanup();
}
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall good');
