// Regression: with tools enabled, the next upstream request must carry the previous segment's reasoning
// item before that segment's function_call. DeepSeek thinking mode returns 400 when it is missing.
// Run: node scripts/test-reasoning-replay.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { closeSync, mkdtempSync, mkdirSync, openSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = mkdtempSync(join(tmpdir(), 'pageask-reasoning-home-'));
const data = mkdtempSync(join(tmpdir(), 'pageask-reasoning-data-'));
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
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
  });

const streamBodies = [];
const upstreamPort = await freePort();
const upstream = createServer(async (req, res) => {
  const body = await readBody(req);
  if (!req.url.endsWith('/responses')) return res.writeHead(404).end();
  if (!body.stream) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'resp_title', output: [{ type: 'message', content: [{ type: 'output_text', text: '标题' }] }] }));
    return;
  }
  streamBodies.push(body);
  const first = streamBodies.length === 1;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  if (first) {
    res.write(
      `event: response.reasoning_text.delta\ndata: ${JSON.stringify({ type: 'response.reasoning_text.delta', delta: '先想一下' })}\n\n`,
    );
    res.write(
      `event: response.completed\ndata: ${JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp_1',
          status: 'completed',
          output: [
            {
              type: 'reasoning',
              id: 'rs_upstream_1',
              status: 'completed',
              summary: [],
              content: [{ type: 'reasoning_text', text: '先想一下' }],
            },
            {
              type: 'function_call',
              id: 'fc_1',
              call_id: 'call_1',
              name: 'read_page',
              arguments: '{"scope":"page"}',
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      })}\n\n`,
    );
  } else {
    res.write(
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: '完成' })}\n\n`,
    );
    res.write(
      `event: response.completed\ndata: ${JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp_2',
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: '完成' }] }],
          usage: { input_tokens: 20, output_tokens: 3 },
        },
      })}\n\n`,
    );
  }
  res.end();
});
await new Promise((resolve) => upstream.listen(upstreamPort, '127.0.0.1', resolve));

const settingsFile = join(home, '.config', 'righthandman', 'settings.json');
const outLog = join(home, 'backend.out.log');
const errLog = join(home, 'backend.err.log');

const writeSettings = (listenPort) => {
  writeFileSync(
    settingsFile,
    JSON.stringify({
      baseUrl: `http://127.0.0.1:${upstreamPort}`,
      model: 'fake',
      apiKey: 'test-key',
      state: 'off',
      port: listenPort,
      token: '',
      dataDir: data,
    }),
  );
};

const readLog = (path) => {
  try {
    return readFileSync(path, 'utf8').slice(-2000).trim();
  } catch {
    return '';
  }
};

// Put the child's logs in files, not pipes: this test must also run under the agent sandbox,
// where piped stdio is blocked, and a failed startup needs the backend's own error message.
const startBackend = (listenPort) => {
  writeSettings(listenPort);
  const out = openSync(outLog, 'w');
  const err = openSync(errLog, 'w');
  const proc = spawn(process.execPath, [join(root, 'server', 'index.mjs')], {
    env: { ...process.env, USERPROFILE: home, HOME: home },
    stdio: ['ignore', out, err],
  });
  closeSync(out);
  closeSync(err);
  return proc;
};

let child = null;
let port = await freePort();
const waitUp = async (listenPort) => {
  const base = `http://127.0.0.1:${listenPort}`;
  for (let i = 0; i < 200; i += 1) {
    if (child.exitCode !== null) return false;
    try {
      const response = await fetch(`${base}/health/live`);
      if (response.ok) return true;
    } catch {
      /* not yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
};

const stopChild = async () => {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await new Promise((resolve) => {
    child.once('exit', resolve);
    setTimeout(resolve, 3000);
  });
};

child = startBackend(port);
let up = await waitUp(port);
if (!up) {
  // The free-port probe has a TOCTOU window: another process can take the port before the backend
  // binds it. Retry once on a fresh port and keep the first attempt's log for diagnosis.
  const firstOut = readLog(outLog);
  const firstErr = readLog(errLog);
  await stopChild();
  port = await freePort();
  child = startBackend(port);
  up = await waitUp(port);
  if (!up) console.error(`first backend attempt:\n${firstOut}\n${firstErr}`.trim());
}
const base = `http://127.0.0.1:${port}`;

try {
  check('后端启动', up, `exit=${child.exitCode}\n${readLog(outLog)}\n${readLog(errLog)}`);
  const created = await fetch(`${base}/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com/reasoning', title: 'reasoning' }),
  }).then((response) => response.json());

  const response = await fetch(`${base}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversationId: created.id,
      page: { url: 'https://example.com/reasoning', title: 'reasoning', markdown: '正文', kind: 'web' },
      text: '问题',
    }),
  });
  const sse = await response.text();

  check('两次上游请求', streamBodies.length === 2, String(streamBodies.length));
  const input = streamBodies[1]?.input;
  check('第二次请求是数组输入', Array.isArray(input), JSON.stringify(input)?.slice(0, 200));
  const reasoning = Array.isArray(input) ? input.find((item) => item.type === 'reasoning') : null;
  check('回传 reasoning 项', Boolean(reasoning), JSON.stringify(input)?.slice(0, 300));
  check('reasoning 正文完整', reasoning?.content?.[0]?.text === '先想一下', JSON.stringify(reasoning));
  check('不带 encrypted_content', reasoning && !('encrypted_content' in reasoning));
  check('summary 只是空占位', Array.isArray(reasoning?.summary) && reasoning.summary.length === 0);
  const reasoningIndex = Array.isArray(input) ? input.indexOf(reasoning) : -1;
  const callIndex = Array.isArray(input) ? input.findIndex((item) => item.type === 'function_call') : -1;
  const outputIndex = Array.isArray(input) ? input.findIndex((item) => item.type === 'function_call_output') : -1;
  check('reasoning 在 function_call 之前', reasoningIndex >= 0 && callIndex > reasoningIndex, `${reasoningIndex}/${callIndex}`);
  check('function_call 有配对的 output', callIndex >= 0 && outputIndex > callIndex, `${callIndex}/${outputIndex}`);
  check('SSE 正常完成', sse.includes('event: content') && sse.includes('event: done'));
} finally {
  child.kill();
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    setTimeout(resolve, 3000);
  });
  upstream.closeAllConnections?.();
  await new Promise((resolve) => upstream.close(resolve));
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* Windows may hold the sqlite handle briefly */
  }
}

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exitCode = failures ? 1 : 0;
