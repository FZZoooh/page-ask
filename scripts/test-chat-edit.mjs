// Regression: inline edit rewrites one user message and regenerates from there, dropping every later row.
// Run: node scripts/test-chat-edit.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = mkdtempSync(join(tmpdir(), 'pageask-edit-home-'));
const data = mkdtempSync(join(tmpdir(), 'pageask-edit-data-'));
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
let lastStreamBody = null;
const upstreamPort = await freePort();
const upstream = createServer(async (req, res) => {
  const body = await readBody(req);
  if (!req.url.endsWith('/responses')) return res.writeHead(404).end();
  if (!body.stream) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'resp_title', output: [{ type: 'message', content: [{ type: 'output_text', text: '标题' }] }] }));
    return;
  }
  streamCount += 1;
  lastStreamBody = body;
  const answer = `回答${streamCount}`;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  res.write(
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: answer })}\n\n`,
  );
  res.write(
    `event: response.completed\ndata: ${JSON.stringify({
      type: 'response.completed',
      response: {
        id: `resp_${streamCount}`,
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: answer }] }],
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
const url = 'https://example.com/edit';
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

const page = { url, title: 't', markdown: '正文', kind: 'web' };
const postChat = (conversationId, text, extra = {}) =>
  fetch(`${base}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId, page, text, ...extra }),
  });

const metaOf = (sse) => {
  const m = /event: meta\ndata: (.*)\n/.exec(sse);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
};

const getConv = (id) => fetch(`${base}/conversations/${encodeURIComponent(id)}`).then((r) => r.json());

try {
  check('backend started', await waitUp());
  const created = await fetch(`${base}/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, title: 't' }),
  }).then((r) => r.json());

  // Two complete turns: the edit must overwrite the second one, not just the last answer.
  const first = await postChat(created.id, '第一问');
  const firstSse = await first.text();
  check('first turn completes', first.status === 200 && firstSse.includes('event: done'), firstSse.slice(-200));
  check('first turn meta carries the user message id', Boolean(metaOf(firstSse)?.messageId), firstSse.slice(0, 200));

  const second = await postChat(created.id, '第二问');
  const secondSse = await second.text();
  check('second turn completes', second.status === 200 && secondSse.includes('event: done'), secondSse.slice(-200));

  const before = await getConv(created.id);
  check('four messages before editing', before.messages?.length === 4, JSON.stringify(before.messages?.map((m) => m.role)));
  const firstUser = before.messages?.[0];
  const firstUserSseId = metaOf(firstSse)?.messageId;
  check('first message is the user message', firstUser?.role === 'user' && firstUser?.content === '第一问');
  check('meta user id matches the stored one', firstUser?.id === firstUserSseId, `${firstUser?.id} != ${firstUserSseId}`);

  const edited = await postChat(created.id, '第一问（改）', { editMessageId: firstUser.id });
  const editedText = await edited.text();
  check('edit request returns 200', edited.status === 200, editedText.slice(0, 300));
  check('edit turn completes', editedText.includes('event: done') && !editedText.includes('event: error'));
  check('edit turn meta keeps the same user message', metaOf(editedText)?.messageId === firstUser.id, editedText.slice(0, 200));

  const after = await getConv(created.id);
  check('only two messages remain after editing', after.messages?.length === 2, JSON.stringify(after.messages?.map((m) => m.role)));
  check('user message text is rewritten', after.messages?.[0]?.content === '第一问（改）', after.messages?.[0]?.content);
  check('user message id is unchanged', after.messages?.[0]?.id === firstUser.id);
  check('the answer after it is regenerated', after.messages?.[1]?.role === 'assistant' && after.messages?.[1]?.content === '回答3');
  check('upstream history drops the overwritten second question', !JSON.stringify(lastStreamBody).includes('第二问'));
  check('upstream history has the rewritten first question', JSON.stringify(lastStreamBody).includes('第一问（改）'));

  // A bad target must fail without touching the conversation, including an assistant row id.
  const unknown = await postChat(created.id, 'x', { editMessageId: 'not-a-message' });
  const unknownBody = await unknown.json();
  check('unknown message returns 400', unknown.status === 400, JSON.stringify(unknownBody));
  check('code is chat.message_not_found', unknownBody.code === 'chat.message_not_found', JSON.stringify(unknownBody));

  const assistantId = after.messages?.[1]?.id;
  const wrongRole = await postChat(created.id, 'x', { editMessageId: assistantId });
  const wrongRoleBody = await wrongRole.json();
  check('an assistant row cannot be edited', wrongRole.status === 400 && wrongRoleBody.code === 'chat.message_not_found');

  const both = await postChat(created.id, 'x', { editMessageId: after.messages?.[0]?.id, regenerate: true });
  const bothBody = await both.json();
  check('edit and regenerate are mutually exclusive', both.status === 400 && bothBody.code === 'chat.invalid_edit', JSON.stringify(bothBody));

  const unchanged = await getConv(created.id);
  check('a failed edit leaves the conversation untouched', unchanged.messages?.length === 2 && unchanged.messages?.[0]?.content === '第一问（改）');
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
