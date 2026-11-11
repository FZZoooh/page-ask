// Regression: `--debug` gates verbose diagnostics. With it, auto-title logs the full LLM request and
// response (and never the API key); without it, the backend stays silent. Run:
// node scripts/test-debug-flag.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// A recognizable key: it travels in the Authorization header and must never reach stderr or the log.
const SECRET = 'sk-SECRET-DO-NOT-LOG-1234567890';
const PREFIX = '[pageask:debug] auto-title ';

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

const debugRecords = (stderr) =>
  stderr
    .split('\n')
    .filter((l) => l.startsWith(PREFIX))
    .map((l) => JSON.parse(l.slice(PREFIX.length)));

// Start a fake upstream + backend (with or without --debug), ask one question, and collect stderr.
async function runScenario(debug) {
  const home = mkdtempSync(join(tmpdir(), 'pageask-dbg-home-'));
  const data = mkdtempSync(join(tmpdir(), 'pageask-dbg-data-'));
  mkdirSync(join(home, '.config', 'righthandman'), { recursive: true });

  const upstreamPort = await freePort();
  const upstream = createServer(async (req, res) => {
    const body = await readBody(req);
    if (!req.url.endsWith('/responses')) return res.writeHead(404).end();
    if (!body.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'resp_title',
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: '调试标题' }] }],
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
      apiKey: SECRET,
      state: 'off',
      port,
      token: '',
      dataDir: data,
    }),
  );

  const args = [join(root, 'server', 'index.mjs')];
  if (debug) args.push('--debug');
  const child = spawn(process.execPath, args, {
    env: { ...process.env, USERPROFILE: home, HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => {
    stdout += c.toString();
  });
  child.stderr.on('data', (c) => {
    stderr += c.toString();
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

  let sse = '';
  let started = false;
  try {
    started = await waitUp();
    if (started) {
      const res = await fetch(`${base}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          page: { url: 'https://example.com/dbg', title: '页面标题', markdown: '正文', kind: 'web' },
          text: '调试问题',
        }),
      });
      sse = await res.text();
      // auto-title runs after 'done' but before the stream closes; let the stderr pipe flush.
      await new Promise((r) => setTimeout(r, 300));
    }
    return { stdout, stderr, sse, started };
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
}

const titleOf = (sse) => {
  const m = sse.match(/event: title\ndata: (.+)\n\n/);
  return m ? JSON.parse(m[1]).title : null;
};

// --- debug ON ---
const on = await runScenario(true);
check('debug: backend started', on.started);
check('debug: startup banner present', on.stdout.includes('debug logging on (--debug)'));
const recs = debugRecords(on.stderr);
const req = recs.find((r) => r.phase === 'request');
const resp = recs.find((r) => r.phase === 'response');
const result = recs.find((r) => r.phase === 'result');
check('debug: request record logged', Boolean(req));
check('debug: request carries the full instructions', Boolean(req?.body?.instructions?.includes('You write a title')));
check(
  'debug: request carries the full input (the user question)',
  Boolean(req?.body?.input?.[0]?.content?.[0]?.text?.includes('调试问题')),
  JSON.stringify(req?.body?.input),
);
check('debug: response record logged with status 200', resp?.status === 200 && resp?.ok === true, JSON.stringify(resp));
check('debug: response carries the full raw output', Boolean(resp?.body?.includes('调试标题')), String(resp?.body).slice(0, 200));
check('debug: result record carries the cleaned title', result?.title === '调试标题', JSON.stringify(result));
check('debug: title still emitted over SSE', titleOf(on.sse) === '调试标题', on.sse.slice(-200));
check('debug: API key never appears in output', !on.stderr.includes(SECRET) && !on.stdout.includes(SECRET));

// --- debug OFF ---
const off = await runScenario(false);
check('plain: backend started', off.started);
check('plain: no debug banner', !off.stdout.includes('debug logging on'));
check('plain: no debug records', debugRecords(off.stderr).length === 0, off.stderr.slice(0, 200));
check('plain: title still generated without debug', titleOf(off.sse) === '调试标题', off.sse.slice(-200));
check('plain: API key never appears in output', !off.stderr.includes(SECRET) && !off.stdout.includes(SECRET));

console.log(failures ? `\n${failures} failure(s)` : '\nall good');
process.exitCode = failures ? 1 : 0;