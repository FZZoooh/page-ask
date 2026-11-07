// 回归：上游 response.incomplete（常见于 max_output_tokens 截断）要保留正文并标记 aborted，
// 非法 JSON 请求要 400 而不是顶层 500。用法：node scripts/test-incomplete-and-bad-body.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = mkdtempSync(join(tmpdir(), 'pageask-inc-home-'));
const data = mkdtempSync(join(tmpdir(), 'pageask-inc-data-'));
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

const upstreamPort = await freePort();
const upstream = createServer((req, res) => {
  req.resume();
  if (req.url === '/responses') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(
      `event: response.output_text.delta\ndata: ${JSON.stringify({
        type: 'response.output_text.delta',
        delta: '半截',
      })}\n\n`,
    );
    res.write(
      `event: response.incomplete\ndata: ${JSON.stringify({
        type: 'response.incomplete',
        response: {
          id: 'resp_inc',
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: '半截' }],
            },
          ],
          usage: { input_tokens: 5, output_tokens: 2 },
        },
      })}\n\n`,
    );
    res.end();
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => upstream.listen(upstreamPort, '127.0.0.1', r));

writeFileSync(
  join(home, '.config', 'pageask', 'settings.json'),
  JSON.stringify({ baseUrl: `http://127.0.0.1:${upstreamPort}`, model: 'fake', apiKey: 'test-key', state: 'off' }),
);

const port = await freePort();
const child = spawn(process.execPath, [join(root, 'server', 'index.mjs')], {
  env: { ...process.env, USERPROFILE: home, HOME: home, PAGEASK_DATA_DIR: data, PAGEASK_PORT: String(port) },
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

const postJson = (path, body) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

try {
  check('后端启动', await waitUp());

  const res = await postJson(
    '/chat',
    JSON.stringify({
      page: { url: 'https://example.com/inc', title: 't', markdown: '正文', kind: 'web' },
      text: '你好',
    }),
  );
  const sse = await res.text();
  check('截断仍返回 SSE', res.status === 200 && sse.includes('event: done'), sse.slice(0, 200));
  check('done 标记 aborted', /"aborted":true/.test(sse), sse.slice(-400));
  check('截断前正文保留', sse.includes('半截'), sse.slice(0, 300));
  check('截断轮次不起标题', !sse.includes('event: title'));

  const badChat = await postJson('/chat', '{ not json');
  const badChatBody = await badChat.text();
  check('非法 /chat JSON 返回 400', badChat.status === 400, `${badChat.status} ${badChatBody.slice(0, 120)}`);
  check('400 文案可读', badChatBody.includes('bad request body'), badChatBody.slice(0, 120));

  const badConv = await postJson('/conversations', '{ not json');
  const badConvBody = await badConv.text();
  check('非法 /conversations JSON 返回 400', badConv.status === 400, `${badConv.status} ${badConvBody.slice(0, 120)}`);
} finally {
  child.kill();
  await new Promise((r) => {
    if (child.exitCode !== null) return r();
    child.once('exit', r);
    setTimeout(r, 3000);
  });
  upstream.closeAllConnections?.();
  await new Promise((r) => upstream.close(r));

  // 落库检查放在进程退出后：WAL 已 checkpoint 或仍可读
  try {
    const db = new DatabaseSync(join(data, 'pageask.db'));
    const row = db
      .prepare("SELECT aborted, content FROM messages WHERE role = 'assistant' ORDER BY rowid DESC LIMIT 1")
      .get();
    check('数据库标记 aborted', row?.aborted === 1, JSON.stringify(row));
    check('数据库保留正文', row?.content === '半截', JSON.stringify(row));
    db.close();
  } catch (err) {
    check('读取数据库', false, err.message);
  }

  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* Windows 上 sqlite 句柄偶尔晚一点释放，临时目录留给系统清理 */
  }
}

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exitCode = failures ? 1 : 0;
