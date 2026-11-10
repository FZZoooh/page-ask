// Regression: upstreams may frame SSE with CRLF. The backend parser used to split only on "\n\n",
// so a standards-compliant CRLF stream produced no content and no done event.
// Run: node scripts/test-sse-crlf.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = mkdtempSync(join(tmpdir(), 'pageask-crlf-home-'));
const data = mkdtempSync(join(tmpdir(), 'pageask-crlf-data-'));
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
  if (req.url.endsWith('/responses')) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(
      'event: response.output_text.delta\r\n' +
        `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'CRLF 正常' })}\r\n\r\n`,
    );
    res.write(
      'event: response.completed\r\n' +
        `data: ${JSON.stringify({
          type: 'response.completed',
          response: { id: 'resp_crlf', usage: { input_tokens: 5, output_tokens: 3 } },
        })}\r\n\r\n`,
    );
    res.end();
    return;
  }
  res.writeHead(404).end();
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
      page: { url: 'https://example.com/crlf', title: 't', markdown: '正文', kind: 'web' },
      text: '测试 CRLF',
    }),
  });
  const sse = await res.text();
  check('returns SSE', res.status === 200, `status ${res.status}`);
  check('a CRLF stream still yields content', sse.includes('event: content') && sse.includes('CRLF 正常'), sse.slice(0, 300));
  check('a CRLF stream still yields done', sse.includes('event: done'), sse.slice(0, 300));

  const meta = sse.match(/event: meta\ndata: (.+)\n\n/);
  const conversationId = meta ? JSON.parse(meta[1]).conversationId : null;
  check('meta carries conversationId', Boolean(conversationId));
  if (conversationId) {
    const stored = await (await fetch(`${base}/conversations/${conversationId}`)).json();
    const answer = stored.messages.filter((m) => m.role === 'assistant').at(-1);
    check('the answer is stored', answer?.content === 'CRLF 正常', JSON.stringify(answer?.content));
  }
} finally {
  child.kill();
  await new Promise((r) => {
    if (child.exitCode !== null) return r();
    child.once('exit', r);
    setTimeout(() => {
      child.kill('SIGKILL');
      r();
    }, 2000);
  });
  upstream.closeAllConnections?.();
  await new Promise((r) => upstream.close(r));
  try {
    rmSync(home, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  } catch {
    // Windows may still hold a WAL handle; temp cleanup will get it
  }
}

process.exitCode = failures ? 1 : 0;
