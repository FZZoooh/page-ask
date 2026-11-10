// Regression: auto-title must use the same /v1 base as normal chat, must not ask the upstream to store the
// title prompt, and state=off must send store:false on the answer request too. Run:
// node scripts/test-auto-title.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = mkdtempSync(join(tmpdir(), 'pageask-title-home-'));
const data = mkdtempSync(join(tmpdir(), 'pageask-title-data-'));
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

const requests = [];
const upstreamPort = await freePort();
const upstream = createServer(async (req, res) => {
  const body = await readBody(req);
  requests.push({ path: req.url, body });
  if (!req.url.endsWith('/responses')) return res.writeHead(404).end();
  if (!body.stream) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'resp_title',
        output: [{ type: 'message', content: [{ type: 'output_text', text: '自动标题' }] }],
        usage: { input_tokens: 2, output_tokens: 2 },
      }),
    );
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  res.write(
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: '答案' })}\n\n`,
  );
  res.write(
    `event: response.completed\ndata: ${JSON.stringify({
      type: 'response.completed',
      response: {
        id: 'resp_answer',
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: '答案' }] }],
        usage: { input_tokens: 5, output_tokens: 2 },
      },
    })}\n\n`,
  );
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
      page: { url: 'https://example.com/title', title: '页面标题', markdown: '正文', kind: 'web' },
      text: '问题',
    }),
  });
  const sse = await res.text();
  const titleEvent = sse.match(/event: title\ndata: (.+)\n\n/);
  const meta = sse.match(/event: meta\ndata: (.+)\n\n/);
  const conversationId = meta ? JSON.parse(meta[1]).conversationId : null;

  check('返回标题事件', Boolean(titleEvent), sse.slice(-300));
  check('标题内容正确', titleEvent && JSON.parse(titleEvent[1]).title === '自动标题', sse.slice(-300));

  check('对话与标题都走 /v1/responses', requests.length === 2 && requests.every((r) => r.path === '/v1/responses'), JSON.stringify(requests.map((r) => r.path)));
  const answerReq = requests.find((r) => r.body.stream);
  const titleReq = requests.find((r) => !r.body.stream);
  check('state=off 时回答请求显式 store:false', answerReq?.body.store === false, JSON.stringify(answerReq?.body));
  check('标题请求显式 store:false', titleReq?.body.store === false, JSON.stringify(titleReq?.body));

  const stored = await fetch(`${base}/conversations/${encodeURIComponent(conversationId)}`);
  const conversation = await stored.json();
  check('标题已写入会话', conversation.title === '自动标题', conversation.title);
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
