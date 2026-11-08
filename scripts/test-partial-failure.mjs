// Regression: upstream streams some text, then reports response.failed. The text already shown in the
// panel must be persisted as an aborted assistant row, not lost on reload. Run:
// node scripts/test-partial-failure.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = mkdtempSync(join(tmpdir(), 'pageask-partial-home-'));
const data = mkdtempSync(join(tmpdir(), 'pageask-partial-data-'));
mkdirSync(join(home, '.config', 'pageask'), { recursive: true });

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
    res.write('event: response.output_text.delta\n');
    res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: '半截回答' })}\n\n`);
    res.write('event: response.failed\n');
    res.write(
      `data: ${JSON.stringify({
        type: 'response.failed',
        response: { status: 'failed', error: { code: 'server_error', message: 'boom' } },
      })}\n\n`,
    );
    res.end();
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => upstream.listen(upstreamPort, '127.0.0.1', r));

const port = await freePort();
writeFileSync(
  join(home, '.config', 'pageask', 'settings.json'),
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
  check('后端启动', await waitUp());
  const res = await fetch(`${base}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      page: { url: 'https://example.com/partial', title: 't', markdown: '正文', kind: 'web' },
      text: '提问',
    }),
  });
  const sse = await res.text();
  check('返回 SSE', res.status === 200 && sse.includes('event: content'), sse.slice(0, 300));
  check('收到半截正文', sse.includes('半截回答'), sse.slice(0, 300));
  check('收到 error 而不是 done', sse.includes('event: error') && !sse.includes('event: done'), sse.slice(-300));

  const meta = sse.match(/event: meta\ndata: (.+)\n\n/);
  const conversationId = meta ? JSON.parse(meta[1]).conversationId : null;
  check('meta 带 conversationId', Boolean(conversationId), sse.slice(0, 200));

  const stored = await fetch(`${base}/conversations/${encodeURIComponent(conversationId)}`);
  const body = await stored.json();
  const assistant = body.messages?.filter((m) => m.role === 'assistant') ?? [];
  check('历史里有 assistant 行', assistant.length === 1, JSON.stringify(assistant).slice(0, 300));
  check('保存的是已显示正文', assistant[0]?.content === '半截回答', JSON.stringify(assistant[0]).slice(0, 300));
  check('标记为 aborted', assistant[0]?.aborted === true, JSON.stringify(assistant[0]).slice(0, 300));
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
    /* Windows may hold the sqlite handle briefly; the temp dir is harmless */
  }
}

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exitCode = failures ? 1 : 0;
