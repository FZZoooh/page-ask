// Regression: quote chips stored in user messages (<pageask-quote> / <pageask-file>) are UI markup.
// The upstream request must receive Markdown blockquotes instead ("> …" / "> file: name") with the
// entity escapes undone, storage keeps the chips verbatim, the title path gets plain text, and new
// rows carry messages.format_version. Run: node scripts/test-quote-chips.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = mkdtempSync(join(tmpdir(), 'pageask-chips-home-'));
const data = mkdtempSync(join(tmpdir(), 'pageask-chips-data-'));
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

let lastStreamBody = null;
let lastTitleBody = null;
const upstreamPort = await freePort();
const upstream = createServer(async (req, res) => {
  const body = await readBody(req);
  if (!req.url.endsWith('/responses')) return res.writeHead(404).end();
  if (!body.stream) {
    lastTitleBody = body;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'resp_title', output: [{ type: 'message', content: [{ type: 'output_text', text: '标题' }] }] }));
    return;
  }
  lastStreamBody = body;
  const answer = '回答';
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  res.write(
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: answer })}\n\n`,
  );
  res.write(
    `event: response.completed\ndata: ${JSON.stringify({
      type: 'response.completed',
      response: { id: 'resp_1', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: answer }] }] },
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
const url = 'https://example.com/chips';
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
  const created = await fetch(`${base}/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, title: 't' }),
  }).then((r) => r.json());

  // A text quote with a newline and entity escapes, plus an artifact reference: every trap in one question.
  const question =
    '对比 <pageask-quote>第一行\n第二行 &amp; &lt;b&gt;加粗&lt;/b&gt;</pageask-quote> 和 <pageask-file>report.html</pageask-file>';
  const res = await fetch(`${base}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: created.id, page: { url, title: 't', markdown: '正文', kind: 'web' }, text: question }),
  });
  const sse = await res.text();
  check('turn completes', res.status === 200 && sse.includes('event: done'), sse.slice(-200));

  const userItem = lastStreamBody?.input?.find((item) => item.role === 'user');
  const text = userItem?.content?.find((c) => c.type === 'input_text')?.text ?? '';
  check('upstream input has the text quote as a blockquote', text.includes('\n\n> 第一行\n> 第二行 & <b>加粗</b>\n\n'), JSON.stringify(text));
  check('upstream input has the artifact reference as "> file: name"', text.includes('\n\n> file: report.html\n\n'), JSON.stringify(text));
  check('upstream input leaks no chip tags', !text.includes('pageask-'), text);
  check('upstream input has the entities decoded', !text.includes('&amp;') && !text.includes('&lt;'), text);

  const conv = await fetch(`${base}/conversations/${encodeURIComponent(created.id)}`).then((r) => r.json());
  const stored = conv.messages?.find((m) => m.role === 'user')?.content ?? '';
  check(
    'stored user content still carries both chip tags',
    stored.includes('<pageask-quote>第一行\n第二行 &amp; &lt;b&gt;加粗&lt;/b&gt;</pageask-quote>') &&
      stored.includes('<pageask-file>report.html</pageask-file>'),
    stored,
  );

  const titleText = lastTitleBody?.input?.[0]?.content?.[0]?.text ?? '';
  check(
    'title request gets plain text, no chip tags',
    titleText.startsWith('User asked: ') && titleText.includes('第一行') && titleText.includes('report.html') && !titleText.includes('pageask-'),
    titleText,
  );

  const shutdown = await fetch(`${base}/api/shutdown`, { method: 'POST', headers: { Origin: base } });
  check('graceful shutdown returns 202', shutdown.status === 202);
  await new Promise((r) => setTimeout(r, 800));

  const db = new DatabaseSync(join(data, 'righthandman.db'));
  const rows = db.prepare('SELECT role, format_version, content FROM messages ORDER BY created_at').all();
  db.close();
  check('every new row is stamped with format_version 1', rows.length > 0 && rows.every((r) => r.format_version === 1), JSON.stringify(rows.map((r) => r.format_version)));
  check('the stored user row keeps the chip markup', rows.some((r) => r.role === 'user' && r.content.includes('<pageask-file>')), '');
} finally {
  child?.kill();
  for (const dir of [home, data]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* temp best effort */
    }
  }
  upstream.close();
}

if (failures) {
  console.log(`${failures} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('all good');
}
