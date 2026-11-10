// Regression: the UI locale still localizes the auto-title request, while the answer prompt is static
// English for every locale (the model mirrors the user's language). Page metadata travels in a
// developer message, not in the instructions. Run: node scripts/test-i18n-chat.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = mkdtempSync(join(tmpdir(), 'pageask-i18n-home-'));
const data = mkdtempSync(join(tmpdir(), 'pageask-i18n-data-'));
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
        output: [{ type: 'message', content: [{ type: 'output_text', text: '标题' }] }],
        usage: { input_tokens: 2, output_tokens: 2 },
      }),
    );
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ delta: 'ok' })}\n\n`);
  res.write(
    `event: response.completed\ndata: ${JSON.stringify({
      type: 'response.completed',
      response: {
        id: `resp_${requests.length}`,
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
        usage: { input_tokens: 5, output_tokens: 1 },
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

const send = async (locale) => {
  const before = requests.length;
  const res = await fetch(`${base}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      page: { url: `https://example.com/${locale}`, title: 'Page title', markdown: 'Body', kind: 'web' },
      text: locale === 'en-US' ? 'What is this?' : '这是什么？',
      locale,
    }),
  });
  await res.text();
  return requests.slice(before);
};

try {
  check('后端启动', await waitUp());

  const zh = await send('zh-CN');
  const zhAnswer = zh.find((r) => r.body.stream);
  const zhTitle = zh.find((r) => !r.body.stream);
  const zhDev = zhAnswer?.body.input?.find((item) => item?.role === 'developer');
  check('zh-CN 标题指令要求中文', zhTitle?.body.instructions.includes('Write the title in Simplified Chinese'));
  check('zh-CN 系统提示不再含中文', !/[\u4e00-\u9fff]/.test(zhAnswer?.body.instructions ?? ''));
  check('zh-CN 页面信息在 developer 消息', Boolean(zhDev) && zhDev.content?.[0]?.text?.includes('source="page-metadata"'));
  check('回答指令不再固定语言', !/Answer in (English|Simplified Chinese)/.test(zhAnswer?.body.instructions ?? ''));

  const en = await send('en-US');
  const enAnswer = en.find((r) => r.body.stream);
  const enTitle = en.find((r) => !r.body.stream);
  const enDev = enAnswer?.body.input?.find((item) => item?.role === 'developer');
  check('en-US 标题指令要求英文', enTitle?.body.instructions.includes('Write the title in English'));
  check('en-US 系统提示不含中文', !/[\u4e00-\u9fff]/.test(enAnswer?.body.instructions ?? ''));
  check('en-US 页面信息在 developer 消息', Boolean(enDev) && enDev.content?.[0]?.text?.includes('source="page-metadata"'));
  check('两种 locale 的回答提示完全一致', zhAnswer?.body.instructions === enAnswer?.body.instructions);
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
