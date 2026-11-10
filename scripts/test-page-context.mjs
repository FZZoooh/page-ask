// Regression: page metadata/selection must live in per-turn developer messages, not in the static
// instructions. The notices are persisted so stateless replay repeats them byte-for-byte (prompt-cache
// prefix), metadata is only resent when it changes, the selection is resent every turn, and editing a
// turn refreshes its notice against the preceding turn. Run: node scripts/test-page-context.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = mkdtempSync(join(tmpdir(), 'pageask-context-home-'));
const data = mkdtempSync(join(tmpdir(), 'pageask-context-data-'));
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

let streamCount = 0;
const streamBodies = [];
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
  streamBodies.push(body);
  const answer = `answer${streamCount}`;
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

const page = (over = {}) => ({
  url: 'https://example.com/context',
  title: 'T1',
  markdown: 'AAAA',
  kind: 'web',
  ...over,
});
const selection = (text, context) => ({
  selection: text,
  selectionContext: { context, start: context.indexOf(text), end: context.indexOf(text) + text.length },
});
const post = (conversationId, pageBody, text, extra = {}) =>
  fetch(`${base}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId, page: pageBody, text, ...extra }),
  });
const metaOf = (sse) => {
  const m = /event: meta\ndata: (.*)\n/.exec(sse);
  try {
    return m ? JSON.parse(m[1]) : null;
  } catch {
    return null;
  }
};
const developerTexts = (body) =>
  (body.input ?? []).filter((item) => item?.role === 'developer').map((item) => item.content?.[0]?.text ?? '');
const userTexts = (body) =>
  (body.input ?? []).filter((item) => item?.role === 'user').map((item) => item.content?.[0]?.text ?? '');

try {
  check('后端启动', await waitUp());

  const first = await post(null, page(selection('alpha', 'one alpha two')), '第一问');
  const firstSse = await first.text();
  const firstMeta = metaOf(firstSse);
  const body1 = streamBodies.at(-1);
  const dev1 = developerTexts(body1);
  const notice1 = dev1.at(-1) ?? '';
  check('第一轮完成', first.status === 200 && firstSse.includes('event: done'), firstSse.slice(-200));
  check('首轮使用 page_context 信封', notice1.includes('<page_context>') && notice1.includes('</page_context>'), notice1);
  check('首轮包含标题与 URL', notice1.includes('Title: T1') && notice1.includes('URL: https://example.com/context'));
  check('首轮包含正文长度', notice1.includes('Page text length: about 4 characters'));
  check('首轮包含选区与上下文', notice1.includes('Selected text (between « »): alpha') && notice1.includes('«alpha»'), notice1);
  check('系统提示不含页面元数据', !body1.instructions.includes('T1') && !body1.instructions.includes('alpha'));
  check('developer 在 user 之前', body1.input.findIndex((i) => i.role === 'developer') < body1.input.findIndex((i) => i.role === 'user'));

  const second = await post(firstMeta.conversationId, page(), '第二问');
  const secondSse = await second.text();
  const secondMeta = metaOf(secondSse);
  const body2 = streamBodies.at(-1);
  const dev2 = developerTexts(body2);
  const notice2 = dev2.at(-1) ?? '';
  check('第二轮完成', second.status === 200 && secondSse.includes('event: done'));
  check('元数据未变时只发 update 信封', notice2.includes('<page_context_update>') && !notice2.includes('Title:'), notice2);
  check('选区消失有明确提示', notice2.includes('The previous selection is no longer active.'), notice2);
  check('历史中的首轮通知逐字重放', dev2[0] === notice1, `${dev2[0]}\n---\n${notice1}`);
  check('历史含第一问与回答', userTexts(body2).includes('第一问') && body2.input.some((i) => i.role === 'assistant'));

  const third = await post(firstMeta.conversationId, page({ title: 'T2', markdown: 'BBBBBB', ...selection('beta', 'x beta y') }), '第三问');
  const thirdSse = await third.text();
  const body3 = streamBodies.at(-1);
  const dev3 = developerTexts(body3);
  const notice3 = dev3.at(-1) ?? '';
  check('第三轮完成', third.status === 200 && thirdSse.includes('event: done'));
  check('元数据变化时带新标题与长度', notice3.includes('Title: T2') && notice3.includes('Page text length: about 6 characters'), notice3);
  check('新选区带上下文', notice3.includes('«beta»'), notice3);
  check('两次历史通知逐字重放', dev3[0] === notice1 && dev3[1] === notice2);

  const fourth = await post(firstMeta.conversationId, page({ title: 'T2', markdown: 'BBBBBB' }), '第四问');
  const fourthSse = await fourth.text();
  const body4 = streamBodies.at(-1);
  const dev4 = developerTexts(body4);
  check('第四轮完成', fourth.status === 200 && fourthSse.includes('event: done'));
  check('再次取消选区有提示', dev4.at(-1)?.includes('The previous selection is no longer active.'), dev4.at(-1));

  const fifth = await post(firstMeta.conversationId, page({ title: 'T2', markdown: 'BBBBBB' }), '第五问');
  const fifthSse = await fifth.text();
  const body5 = streamBodies.at(-1);
  check('第五轮完成', fifth.status === 200 && fifthSse.includes('event: done'));
  check('无变化且无选区时不再发 developer 消息', developerTexts(body5).length === 4, String(developerTexts(body5).length));
  check('所有轮次指令完全一致', new Set(streamBodies.map((b) => b.instructions)).size === 1);
  check('指令中没有固定语言', !streamBodies.some((b) => /Answer in (English|Simplified Chinese)/.test(b.instructions)));

  // Editing turn 2: refresh against turn 1's stored context, not against the newest turn.
  const editSecond = await post(
    firstMeta.conversationId,
    page({ title: 'T3', markdown: 'CCCCCC', ...selection('gamma', 'yes gamma no') }),
    '第二问（改）',
    { editMessageId: secondMeta.messageId },
  );
  const editSecondSse = await editSecond.text();
  const bodyEdit2 = streamBodies.at(-1);
  const devEdit2 = developerTexts(bodyEdit2);
  const noticeEdit2 = devEdit2.at(-1) ?? '';
  check('编辑第二轮完成', editSecond.status === 200 && editSecondSse.includes('event: done'));
  check('编辑轮相对首轮生成 update', noticeEdit2.includes('<page_context_update>') && noticeEdit2.includes('Title: T3'), noticeEdit2);
  check('编辑轮带新选区', noticeEdit2.includes('«gamma»'), noticeEdit2);
  check('编辑后只保留首轮与编辑轮', userTexts(bodyEdit2).join('|') === '第一问|第二问（改）', userTexts(bodyEdit2).join('|'));

  // Editing the first turn has no predecessor: send a full page_context again.
  const editFirst = await post(
    firstMeta.conversationId,
    page({ title: 'T4', markdown: 'DDDDDD', ...selection('delta', 'a delta b') }),
    '第一问（改）',
    { editMessageId: firstMeta.messageId },
  );
  const editFirstSse = await editFirst.text();
  const bodyEdit1 = streamBodies.at(-1);
  const devEdit1 = developerTexts(bodyEdit1);
  const noticeEdit1 = devEdit1.at(-1) ?? '';
  check('编辑首轮完成', editFirst.status === 200 && editFirstSse.includes('event: done'));
  check('编辑首轮使用完整 page_context', noticeEdit1.includes('<page_context>') && !noticeEdit1.includes('_update'), noticeEdit1);
  check('编辑首轮带当前页面', noticeEdit1.includes('Title: T4') && noticeEdit1.includes('«delta»'), noticeEdit1);
  check('编辑首轮只剩一个用户消息', userTexts(bodyEdit1).join('|') === '第一问（改）', userTexts(bodyEdit1).join('|'));
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
