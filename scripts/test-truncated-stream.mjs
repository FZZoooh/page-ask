// Regression: a stream that closes cleanly without response.completed is a truncation. The partial text
// must be stored as aborted (not as a complete answer) and the panel must see done.aborted=true. Run:
// node scripts/test-truncated-stream.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = mkdtempSync(join(tmpdir(), 'pageask-trunc-home-'));
const data = mkdtempSync(join(tmpdir(), 'pageask-trunc-data-'));
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
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  res.write(
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: '被截断的回答' })}\n\n`,
  );
  // no response.completed: a proxy closed the stream after some deltas
  res.end();
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
  check('后端启动', await waitUp());
  const res = await fetch(`${base}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      page: { url: 'https://example.com/trunc', title: 't', markdown: '正文', kind: 'web' },
      text: '问题',
    }),
  });
  const sse = await res.text();
  const done = sse.match(/event: done\ndata: (.+)\n\n/);
  const meta = sse.match(/event: meta\ndata: (.+)\n\n/);
  check('有 done 事件', Boolean(done), sse.slice(-300));
  check('done 标记 aborted', done && JSON.parse(done[1]).aborted === true, done?.[1]);
  check('没有生成标题', !sse.includes('event: title'), sse.slice(-300));

  const conversationId = meta ? JSON.parse(meta[1]).conversationId : null;
  const stored = await fetch(`${base}/conversations/${encodeURIComponent(conversationId)}`);
  const body = await stored.json();
  const assistant = body.messages?.find((m) => m.role === 'assistant');
  check('半截正文已落库', assistant?.content === '被截断的回答', JSON.stringify(assistant).slice(0, 300));
  check('历史标记 aborted', assistant?.aborted === true, JSON.stringify(assistant).slice(0, 300));
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
