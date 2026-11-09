// Regression: when response.completed disagrees with the streamed text, the backend must emit one
// `replace` event with the final answer instead of leaving the panel with the delta prefix.
// Run: node scripts/test-replace-sse.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeReplaceUpstream } from './fake-replace-upstream.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = mkdtempSync(join(tmpdir(), 'pageask-replace-home-'));
const data = mkdtempSync(join(tmpdir(), 'pageask-replace-data-'));
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

const upstream = await startFakeReplaceUpstream();
const port = await freePort();
writeFileSync(
  join(home, '.config', 'pageask', 'settings.json'),
  JSON.stringify({
    baseUrl: upstream.url,
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

const parseSse = (text) => {
  const events = [];
  for (const block of text.replaceAll('\r\n', '\n').split('\n\n')) {
    let event = '';
    const data = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('data: ')) data.push(line.slice(6));
    }
    if (!event) continue;
    try {
      events.push({ event, data: JSON.parse(data.join('\n')) });
    } catch {
      /* ignore malformed frames */
    }
  }
  return events;
};

try {
  check('后端启动', await waitUp());

  const res = await fetch(`${base}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      page: { url: 'https://example.com/replace', title: 'replace', markdown: '正文', kind: 'web' },
      text: '问题',
    }),
  });
  const sse = await res.text();
  const events = parseSse(sse);
  const content = events.filter((e) => e.event === 'content').map((e) => e.data.delta).join('');
  const replaces = events.filter((e) => e.event === 'replace');
  const done = events.find((e) => e.event === 'done')?.data;

  check('流式 delta 是 AB', content === 'AB', content);
  check('只发一个 replace', replaces.length === 1, String(replaces.length));
  check('replace 携带最终文本 XY', replaces[0]?.data.text === 'XY', JSON.stringify(replaces[0]?.data));
  check('最终文本没有走 content 追加', !content.includes('XY'), content);
  check('done.message 是最终文本', done?.message?.content === 'XY', JSON.stringify(done?.message));
  check('fake upstream 只收到一次流式请求', upstream.streamRequests === 1, String(upstream.streamRequests));

  const stored = await fetch(`${base}/conversations/${done?.conversationId}`).then((r) => r.json());
  const last = stored.messages?.at(-1);
  check('数据库保存最终文本', last?.content === 'XY', JSON.stringify(last));
} finally {
  child.kill();
  await new Promise((r) => {
    if (child.exitCode !== null) return r();
    child.once('exit', r);
    setTimeout(r, 3000);
  });
  await upstream.close();
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* Windows may hold the sqlite handle briefly */
  }
}

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exitCode = failures ? 1 : 0;
