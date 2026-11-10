// Regression: a broken/hostile upstream can return a huge non-2xx body. The backend must cap it,
// keep the SSE error message short, and stay alive for the next request.
// Run: node scripts/test-upstream-error-cap.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = mkdtempSync(join(tmpdir(), 'pageask-errcap-home-'));
const data = mkdtempSync(join(tmpdir(), 'pageask-errcap-data-'));
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

const upstreamPort = await freePort();
const upstream = createServer((req, res) => {
  req.resume();
  if (!req.url.endsWith('/responses')) return res.writeHead(404).end();
  res.writeHead(500, { 'Content-Type': 'text/plain' });
  // Larger than the 64 KiB cap on purpose. The old code buffered all of it.
  res.end('x'.repeat(8 * 1024 * 1024));
});
await new Promise((r) => upstream.listen(upstreamPort, '127.0.0.1', r));

const port = await freePort();
writeFileSync(
  join(home, '.config', 'righthandman', 'settings.json'),
  JSON.stringify({
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
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

const base = `http://127.0.0.1:${port}`;
const waitUp = async () => {
  for (let i = 0; i < 80; i += 1) {
    try {
      const r = await fetch(`${base}/health/live`);
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

  const res = await fetch(`${base}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      page: { url: 'https://example.com/big-error', title: 't', markdown: '正文', kind: 'web' },
      text: '问题',
    }),
  });
  const sse = await res.text();
  const error = sse.match(/event: error\ndata: (.+)\n\n/);
  check('an error event arrives', Boolean(error), sse.slice(-300));
  const payload = error ? JSON.parse(error[1]) : {};
  check('the code is upstream.status', payload.code === 'upstream.status', payload.code);
  check('the error message is truncated', typeof payload.message === 'string' && payload.message.length < 500,
    `message length=${payload.message?.length}`);
  check('the error message does not include the response body', !payload.message?.includes('x'.repeat(1000)));

  const live = await fetch(`${base}/health/live`);
  check('the backend is still alive', live.ok, String(live.status));
} finally {
  child.kill();
  await new Promise((r) => {
    if (child.exitCode !== null) return r();
    child.once('exit', r);
    setTimeout(r, 3000);
  });
  upstream.closeAllConnections?.();
  await new Promise((r) => upstream.close(r));
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* Windows may hold the sqlite handle briefly */
  }
}

console.log(failures ? `\n${failures} failure(s)` : '\nall good');
process.exitCode = failures ? 1 : 0;
