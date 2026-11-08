// Regression: one in-flight turn per conversation. A second /chat and DELETE during streaming must both
// return 409 conversation.busy; after the turn ends, DELETE succeeds. Run: node scripts/test-chat-busy.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = mkdtempSync(join(tmpdir(), 'pageask-busy-home-'));
const data = mkdtempSync(join(tmpdir(), 'pageask-busy-data-'));
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

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
  });

let releaseFirst;
const firstGate = new Promise((resolve) => {
  releaseFirst = resolve;
});
let streamCount = 0;
const upstreamPort = await freePort();
const upstream = createServer(async (req, res) => {
  const body = await readBody(req);
  if (!req.url.endsWith('/responses')) return res.writeHead(404).end();
  if (!body.stream) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'resp_title',
        output: [{ type: 'message', content: [{ type: 'output_text', text: '标题' }] }],
      }),
    );
    return;
  }
  streamCount += 1;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  res.write(
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: `回答${streamCount}` })}\n\n`,
  );
  if (streamCount === 1) await firstGate;
  res.write(
    `event: response.completed\ndata: ${JSON.stringify({
      type: 'response.completed',
      response: {
        id: `resp_${streamCount}`,
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: `回答${streamCount}` }] }],
      },
    })}\n\n`,
  );
  res.end();
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

const postChat = (conversationId) =>
  fetch(`${base}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversationId,
      page: { url: 'https://example.com/busy', title: 't', markdown: '正文', kind: 'web' },
      text: '问题',
    }),
  });

try {
  check('后端启动', await waitUp());
  const created = await fetch(`${base}/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com/busy', title: 't' }),
  }).then((r) => r.json());

  const first = await postChat(created.id);
  check('第一轮开始', first.status === 200);
  await new Promise((r) => setTimeout(r, 150));

  const second = await postChat(created.id);
  const secondBody = await second.json();
  check('同对话第二轮返回 409', second.status === 409, JSON.stringify(secondBody));
  check('409 错误码是 conversation.busy', secondBody.code === 'conversation.busy', JSON.stringify(secondBody));

  const delBusy = await fetch(`${base}/conversations/${encodeURIComponent(created.id)}`, { method: 'DELETE' });
  check('流式期间删除返回 409', delBusy.status === 409);

  releaseFirst();
  const firstText = await first.text();
  check('第一轮正常完成', firstText.includes('event: done') && !firstText.includes('event: error'), firstText.slice(-300));

  const del = await fetch(`${base}/conversations/${encodeURIComponent(created.id)}`, { method: 'DELETE' });
  check('结束后删除成功', del.status === 200);
} finally {
  releaseFirst();
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
