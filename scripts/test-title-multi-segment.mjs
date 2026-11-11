// Regression: one answer can span several assistant content rows (text emitted between tool calls).
// Auto-title must still fire on the first question: it gates on the user count, not the assistant count.
// The fake upstream returns an intermediate content+tool segment, then a final answer segment. Run:
// node scripts/test-title-multi-segment.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = mkdtempSync(join(tmpdir(), 'pageask-multiseg-home-'));
const data = mkdtempSync(join(tmpdir(), 'pageask-multiseg-data-'));
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

let streamCount = 0;
let titleRequests = 0;
const upstreamPort = await freePort();
const upstream = createServer(async (req, res) => {
  const body = await readBody(req);
  if (!req.url.endsWith('/responses')) return res.writeHead(404).end();
  if (!body.stream) {
    titleRequests += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'resp_title',
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: '多段标题' }] }],
        usage: { input_tokens: 2, output_tokens: 2 },
      }),
    );
    return;
  }
  streamCount += 1;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  if (streamCount === 1) {
    // intermediate segment: visible text AND a tool call, so it persists its own assistant content row
    res.write(
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: '第一段' })}\n\n`,
    );
    res.write(
      `event: response.completed\ndata: ${JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp_1',
          status: 'completed',
          output: [
            { type: 'message', content: [{ type: 'output_text', text: '第一段' }] },
            { type: 'function_call', call_id: 'call_1', name: 'read_page', arguments: '{"scope":"page"}' },
          ],
          usage: { input_tokens: 5, output_tokens: 3 },
        },
      })}\n\n`,
    );
  } else {
    // final segment: text only, ends the turn
    res.write(
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: '第二段' })}\n\n`,
    );
    res.write(
      `event: response.completed\ndata: ${JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp_2',
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: '第二段' }] }],
          usage: { input_tokens: 8, output_tokens: 3 },
        },
      })}\n\n`,
    );
  }
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
  check('backend started', await waitUp());
  const res = await fetch(`${base}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      page: { url: 'https://example.com/multiseg', title: '页面标题', markdown: '正文', kind: 'web' },
      text: '问题',
    }),
  });
  const sse = await res.text();
  const titleEvent = sse.match(/event: title\ndata: (.+)\n\n/);
  const meta = sse.match(/event: meta\ndata: (.+)\n\n/);
  const conversationId = meta ? JSON.parse(meta[1]).conversationId : null;

  check('the turn ran two answer segments', streamCount === 2, String(streamCount));
  check('title event emitted despite two assistant rows', Boolean(titleEvent), sse.slice(-300));
  check('title content matches', titleEvent && JSON.parse(titleEvent[1]).title === '多段标题', sse.slice(-300));
  check('a title request was made', titleRequests === 1, String(titleRequests));

  const stored = await fetch(`${base}/conversations/${encodeURIComponent(conversationId)}`);
  const conversation = await stored.json();
  const contentRows = (role) => (conversation.messages ?? []).filter((m) => m.role === role && String(m.content ?? '').trim() !== '');
  check('exactly one user message', contentRows('user').length === 1, String(contentRows('user').length));
  check('two assistant content rows (the multi-segment case)', contentRows('assistant').length === 2, String(contentRows('assistant').length));
  check('title persisted on the conversation', conversation.title === '多段标题', conversation.title);
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

console.log(failures ? `\n${failures} failure(s)` : '\nall good');
process.exitCode = failures ? 1 : 0;