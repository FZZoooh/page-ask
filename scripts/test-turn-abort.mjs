// 端到端验证两件事（不碰真实配置与数据库）：
//   1. 工具执行中途中止：assistant 的每个 function_call 都补上了 output，
//      回放时不会出现悬空 call；
//   2. 正文流到一半中止：已经流给用户的正文仍然落库，并标记 aborted。
//
// 做法：临时 HOME + 临时数据目录，起一个假上游；真后端以子进程之外的
// 方式在同进程 import（PAGEASK_PORT 用 18787），再用 fetch 打 /chat。
//
// 跑法：node scripts/test-turn-abort.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createProbe } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'pageask-home-'));
const dataDir = mkdtempSync(join(tmpdir(), 'pageask-data-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.PAGEASK_DATA_DIR = dataDir;

// 让系统给一个空闲端口，避免固定端口被占
const probe = createProbe();
await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
const backendPort = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
process.env.PAGEASK_PORT = String(backendPort);

let fakePort = 0;
const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const upstream = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    if (req.url === '/responses') {
      const body = JSON.parse(raw || '{}');
      const userText = (body.input ?? [])
        .filter((i) => i?.role === 'user')
        .map((i) => i.content?.[0]?.text ?? '')
        .join(' ');
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (userText.includes('TOOL')) {
        res.write(
          sse('response.completed', {
            response: {
              id: 'resp_tool',
              output: [
                { type: 'function_call', call_id: 'call_1', name: 'web_search', arguments: '{"query":"a"}' },
                { type: 'function_call', call_id: 'call_2', name: 'web_search', arguments: '{"query":"b"}' },
              ],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          }),
        );
        res.end();
        return;
      }
      if (userText.includes('SLOW')) {
        res.write(sse('response.output_text.delta', { delta: '第一段' }));
        // 不再发 completed，等客户端中止
        setTimeout(() => {
          if (!res.destroyed) res.end();
        }, 5000);
        return;
      }
      if (userText.includes('OK')) {
        res.write(
          sse('response.completed', {
            response: { id: 'resp_ok', output: [{ type: 'message', content: [{ type: 'output_text', text: '好的' }] }] },
          }),
        );
        res.end();
        return;
      }
      res.end();
      return;
    }

    if (req.url === '/v1/tools/search') {
      // 故意慢：让客户端在工具执行期间点“停止”
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results: [{ title: 'x', url: 'https://x.test', summary: 's' }] }));
      }, 1000);
      return;
    }

    res.writeHead(404).end();
  });
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
fakePort = upstream.address().port;

mkdirSync(join(home, '.config', 'pageask'), { recursive: true });
writeFileSync(
  join(home, '.config', 'pageask', 'settings.json'),
  JSON.stringify({
    baseUrl: `http://127.0.0.1:${fakePort}`,
    model: 'fake-model',
    apiKey: 'sk-test',
    state: 'off',
  }),
);

// 动态 import：settings.mjs / db.mjs 在模块加载时读取上面的环境变量
const { getConversation } = await import('../server/db.mjs');
await import('../server/index.mjs');

const base = `http://127.0.0.1:${backendPort}`;
for (let i = 0; i < 50; i += 1) {
  try {
    const r = await fetch(`${base}/health`);
    if (r.ok) break;
  } catch {
    // 还没起来
  }
  await new Promise((r) => setTimeout(r, 100));
}

/** 发一轮对话，读到 stopAfter 事件后中止；返回收到的事件与 conversationId */
async function chat(text, stopAfter, conversationId = null) {
  const controller = new AbortController();
  const res = await fetch(`${base}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversationId,
      page: { url: 'https://example.com/same-page', title: '同一个页面', markdown: '正文' },
      text,
    }),
    signal: controller.signal,
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let convId = null;
  const events = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        let event = 'message';
        let data = '';
        for (const line of chunk.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7);
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (!data) continue;
        const parsed = JSON.parse(data);
        events.push({ event, data: parsed });
        if (event === 'meta') convId = parsed.conversationId;
        if (stopAfter(event, parsed)) {
          controller.abort();
          return { events, conversationId: convId };
        }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') throw err;
  }
  return { events, conversationId: convId };
}

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${name}\n     ${err.message}`);
  }
}

// 1) 工具执行中途中止
const toolRun = await chat('TOOL', (event, data) => event === 'tool' && data.phase === 'start');
let toolConv = null;
for (let i = 0; i < 30; i += 1) {
  toolConv = getConversation(toolRun.conversationId);
  const assistant = toolConv.messages.find((m) => m.role === 'assistant');
  const tools = toolConv.messages.filter((m) => m.role === 'tool');
  if (assistant?.toolCalls?.length === 2 && tools.length === 2) break;
  await new Promise((r) => setTimeout(r, 100));
}
check('工具轮次：assistant 的 2 个 call 都有 tool 行', () => {
  const assistant = toolConv.messages.find((m) => m.role === 'assistant');
  const tools = toolConv.messages.filter((m) => m.role === 'tool');
  assert.equal(assistant.toolCalls.length, 2);
  assert.equal(tools.length, 2);
  assert.deepEqual(tools.map((t) => t.toolCallId).sort(), ['call_1', 'call_2']);
  assert.equal(assistant.aborted, true);
});
check('工具轮次：未执行的 call 有“已中止”占位 output', () => {
  const tools = toolConv.messages.filter((m) => m.role === 'tool');
  const second = tools.find((t) => t.toolCallId === 'call_2');
  assert.match(second.content, /中止|没有执行/);
});

// 2) 正文流到一半中止
const slowRun = await chat('SLOW', (event) => event === 'content');
await new Promise((r) => setTimeout(r, 400));
const slowConv = getConversation(slowRun.conversationId);
check('正文中止：已生成内容落库并标记 aborted', () => {
  const assistant = slowConv.messages.find((m) => m.role === 'assistant');
  assert.ok(assistant, '没有 assistant 行');
  assert.equal(assistant.content, '第一段');
  assert.equal(assistant.aborted, true);
});

// 3) 中止过的会话还能继续问（回放不 400）
const follow = await chat('OK', (event) => event === 'done', slowRun.conversationId);
check('中止后继续对话不报错', () => {
  const errors = follow.events.filter((e) => e.event === 'error');
  assert.equal(errors.length, 0, errors.map((e) => e.data.message).join('; '));
  assert.ok(follow.events.some((e) => e.event === 'done'));
});

upstream.close();
if (failed) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log('\n全部通过');
process.exit(0);
