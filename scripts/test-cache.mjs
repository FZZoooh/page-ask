// Prefix-cache probe: many turns in one conversation, screenshots and tool calls mixed in; prints
// upstream usage per turn. Run: node scripts/test-cache.mjs [port]
// Key metric: usage.input_tokens_details.cached_tokens (input tokens served from cache)
import { readFileSync } from 'node:fs';
import { readSettings } from '../server/settings.mjs';
import { requireRealConfig } from './require-real-config.mjs';

requireRealConfig();

const PORT = Number(process.argv[2] ?? readSettings().port);
const BASE = `http://127.0.0.1:${PORT}`;

const shotPath = process.argv[3] ?? '.cache-shot.jpg';
const shotB64 = readFileSync(shotPath).toString('base64');

const page = {
  url: 'https://example.com/cache-test',
  title: '缓存测试页',
  markdown: [
    '# 浏览器扩展侧栏开发入门',
    '',
    'Manifest V3 引入了 chrome.sidePanel 接口，让扩展可以在浏览器右侧常驻一个面板。',
    '与弹出式 popup 不同，侧栏不会在失去焦点时关闭，因此更适合承载多轮对话这类长时间交互。',
    '',
    '## 三个必备步骤',
    '',
    '1. 在 manifest 中声明 side_panel',
    '2. 申请 sidePanel 权限',
    '3. 调用 sidePanel.setPanelBehavior({ openPanelOnActionClick: true })',
    '',
    '## 读取当前页面的正文',
    '',
    '读取页面依赖 scripting 权限，只有用户点击扩展图标时，浏览器才会把那个标签页的访问权临时授予扩展。',
    '这就是 activeTab 的设计意图——最小权限。',
  ].join('\n'),
  screenshot: `data:image/jpeg;base64,${shotB64}`,
  screenshotWidth: 96,
  screenshotHeight: 96,
};

const TURNS = [
  '先读一遍这一页，再截个图，然后用一句话说明你在屏幕上看到了什么。',
  '把刚才页面里的三个步骤原样列出来，不要加解释。',
  '联网查一下 WXT 的最新版本号是多少，只要版本号。',
  '再看一次截图，回答画面左侧大概是什么内容。',
  '把前面几轮的信息合成三行要点。',
];

function fmtUsage(u) {
  if (!u) return '(no usage)';
  const d = u.input_tokens_details ?? {};
  const cached = d.cached_tokens ?? u.cached_tokens ?? 0;
  const inp = u.input_tokens ?? 0;
  const pct = inp ? ((cached / inp) * 100).toFixed(1) : '0.0';
  return `in=${inp} cached=${cached} (${pct}%) out=${u.output_tokens ?? 0}`;
}

async function turn(conversationId, text) {
  const res = await fetch(`${BASE}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId, page, text }),
  });
  if (!res.ok || !res.body) throw new Error(`chat ${res.status} ${await res.text()}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const usages = [];
  const tools = [];
  let done = null;
  let meta = null;
  let error = null;

  for (;;) {
    const { done: end, value } = await reader.read();
    if (end) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let name = 'message';
      const datas = [];
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (t.startsWith('event:')) name = t.slice(6).trim();
        else if (t.startsWith('data:')) datas.push(t.slice(5).trim());
      }
      if (!datas.length) continue;
      let json = null;
      try {
        json = JSON.parse(datas.join('\n'));
      } catch {
        continue;
      }
      if (name === 'meta') meta = json;
      else if (name === 'usage') usages.push(json);
      else if (name === 'tool' && json.phase === 'end') tools.push(json.label ?? json.name);
      else if (name === 'done') done = json;
      else if (name === 'error') error = json;
    }
  }
  return { conversationId: meta?.conversationId, usages, tools, done, error };
}

// Solid-colour JPEG as the "screenshot": identical bytes every turn, else the prefix necessarily differs
console.log(`截图素材：${shotPath}（${shotB64.length} base64 字符）`);
console.log(`轮数：${TURNS.length}\n`);

let convId = null;
const rows = [];
for (let i = 0; i < TURNS.length; i++) {
  const t = await turn(convId, TURNS[i]);
  convId = t.conversationId ?? convId;
  const last = t.usages.at(-1);
  const steps = t.done?.steps ?? t.usages.length;
  rows.push({ i: i + 1, steps, tools: t.tools, usage: last, totals: t.done?.totals });
  console.log(`第 ${i + 1} 轮  步数=${steps}  工具=${t.tools.join(' / ') || '无'}`);
  for (const u of t.usages) console.log(`        usage ${fmtUsage(u)}`);
  if (t.error) console.log(`        [error] ${t.error.message}`);
  const answer = t.done?.message?.content ?? '';
  console.log(`        回答 ${answer.replace(/\s+/g, ' ').slice(0, 70)}`);
  console.log('');
}

console.log('汇总：');
console.log('轮次\t步数\t输入\t命中缓存\t命中率');
for (const r of rows) {
  const u = r.usage ?? {};
  const d = u.input_tokens_details ?? {};
  const cached = d.cached_tokens ?? 0;
  const inp = u.input_tokens ?? 0;
  const pct = inp ? ((cached / inp) * 100).toFixed(1) : '0.0';
  console.log(`${r.i}\t${r.steps}\t${inp}\t${cached}\t${pct}%`);
}

if (convId) {
  const detail = await (await fetch(`${BASE}/conversations/${convId}`)).json();
  console.log(`\n会话 ${convId}：${detail.messages.length} 条消息，标题「${detail.title}」`);
}
