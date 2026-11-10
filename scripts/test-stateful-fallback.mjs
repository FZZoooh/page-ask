// Regression: once a chained request is rejected, this process must stop sending previous_response_id.
// The stateless fallback must also send store:false so it cannot become a new anchor. Run:
// node scripts/test-stateful-fallback.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = mkdtempSync(join(tmpdir(), 'pageask-stateful-home-'));
const data = mkdtempSync(join(tmpdir(), 'pageask-stateful-data-'));
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

const streamBodies = [];
let failedChain = false;
let answerCount = 0;
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
  streamBodies.push(body);
  if (body.previous_response_id && !failedChain) {
    failedChain = true;
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'invalid_request', message: 'previous_response_id not found' } }));
    return;
  }
  answerCount += 1;
  const text = `回答${answerCount}`;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  res.write(
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n`,
  );
  res.write(
    `event: response.completed\ndata: ${JSON.stringify({
      type: 'response.completed',
      response: {
        id: `resp_${answerCount}`,
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
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
    state: 'on',
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
      page: { url: 'https://example.com/stateful', title: 't', markdown: '正文', kind: 'web' },
      text: '问题',
    }),
  }).then((r) => r.text());

try {
  check('backend started', await waitUp());
  const created = await fetch(`${base}/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com/stateful', title: 't' }),
  }).then((r) => r.json());

  await postChat(created.id);
  await postChat(created.id);
  await postChat(created.id);

  check('four answer requests in total', streamBodies.length === 4, JSON.stringify(streamBodies.map((b) => b.previous_response_id)));
  check('the first turn has no anchor and sets store:true', !streamBodies[0].previous_response_id && streamBodies[0].store === true, JSON.stringify(streamBodies[0]));
  check('the second turn starts with previous_response_id', streamBodies[1].previous_response_id === 'resp_1', JSON.stringify(streamBodies[1]));
  check('the fallback request carries no anchor', !streamBodies[2].previous_response_id, JSON.stringify(streamBodies[2]));
  check('the fallback request sets store:false', streamBodies[2].store === false, JSON.stringify(streamBodies[2]));
  check('the third turn no longer tries stateful', !streamBodies[3].previous_response_id, JSON.stringify(streamBodies[3]));
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
