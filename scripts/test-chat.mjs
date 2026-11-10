// Smoke test: hit the backend /chat directly and print the SSE events (no browser in the loop).
// Reads the port and token from ~/.config/righthandman/settings.json, like the backend itself.
// Usage: PAGEASK_ALLOW_REAL=1 node scripts/test-chat.mjs ["question text"]
import { readSettings } from '../server/settings.mjs';
import { requireRealConfig } from './require-real-config.mjs';

requireRealConfig();

const cfg = readSettings();
const port = cfg.port;
const text = process.argv[2] ?? '用两点概括这个页面。';

const res = await fetch(`http://127.0.0.1:${port}/chat`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
  },
  body: JSON.stringify({
    page: {
      url: 'http://127.0.0.1:8811/article.html',
      title: '浏览器扩展侧栏开发入门',
      markdown:
        'Manifest V3 引入了 chrome.sidePanel 接口，让扩展可以在浏览器右侧常驻一个面板。\n\n三个必备步骤：1. 在 manifest 中声明 side_panel；2. 申请 sidePanel 权限；3. 调用 sidePanel.setPanelBehavior({openPanelOnActionClick:true})。',
    },
    text,
  }),
});

if (!res.ok) {
  console.error('HTTP', res.status, await res.text());
  process.exit(1);
}

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
const counts = { reasoning: 0, content: 0 };
let answer = '';
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf('\n\n')) >= 0) {
    const block = buf.slice(0, i);
    buf = buf.slice(i + 2);
    const ev = block.match(/^event: (.+)$/m)?.[1];
    const data = block.match(/^data: (.+)$/m)?.[1];
    if (!ev || !data) continue;
    if (ev === 'reasoning') counts.reasoning++;
    if (ev === 'content') {
      counts.content++;
      answer += JSON.parse(data).delta;
    }
    if (ev === 'meta' || ev === 'done' || ev === 'error' || ev === 'usage') {
      console.log(`[${ev}]`, data.slice(0, 300));
    }
  }
}
console.log(`\nreasoning events: ${counts.reasoning} / content events: ${counts.content}`);
console.log('--- answer ---\n' + answer.slice(0, 600));
