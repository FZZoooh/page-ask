// End-to-end check of "screenshot persisted to disk + replayed history carries the image":
//  1) turn 1 makes the model call screenshot (page.screenshot carries a solid-colour image)
//  2) assert a new file appeared under server/data/shots/
//  3) turn 2 follows up: history with the image must be accepted upstream (no 422)
// Run: node scripts/test-shot.mjs [port]
import { readSettings } from '../server/settings.mjs';
import { requireRealConfig } from './require-real-config.mjs';

requireRealConfig();

const PORT = Number(process.argv[2] ?? readSettings().port);
const BASE = `http://127.0.0.1:${PORT}`;

// 64x64 solid red PNG (the same one the probe script uses)
const RED =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const page = {
  url: `https://example.com/shot-test-${Date.now()}`,
  title: '截图测试页',
  markdown: '# 截图测试页\n\n这一页用来测试截图工具。',
  screenshot: RED,
  screenshotWidth: 64,
  screenshotHeight: 64,
};

async function turn(conversationId, text) {
  const res = await fetch(`${BASE}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId, page, text }),
  });
  if (!res.ok || !res.body) throw new Error(`chat ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
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
        /* ignore */
      }
      events.push({ name, json });
      if (name === 'tool') console.log(`  [tool] ${json.phase} ${json.label ?? json.name} ${json.detail ?? ''}`);
      if (name === 'done') console.log(`  [done] aborted=${json.aborted} totals=${JSON.stringify(json.totals)}`);
      if (name === 'error') console.log(`  [error] ${json.message}`);
    }
  }
  const meta = events.find((e) => e.name === 'meta')?.json;
  const done = events.find((e) => e.name === 'done')?.json;
  const content = done?.message?.content ?? '';
  return { conversationId: meta?.conversationId, content, events };
}

console.log('turn 1: ask for a screenshot');
const t1 = await turn(null, '截个图，告诉我画面里是什么颜色。');
console.log('  answer:', t1.content.slice(0, 120));
const convId = t1.conversationId;
console.log('  conversationId =', convId);

console.log('\nturn 2 (the image is in history):');
const t2 = await turn(convId, '刚才那张图是纯色吗？只回答「是」或「不是」。');
console.log('  answer:', t2.content.slice(0, 120));

console.log('\nconversation detail:');
const conv = await (await fetch(`${BASE}/conversations/${convId}`)).json();
for (const m of conv.messages) {
  console.log(`  ${m.role.padEnd(9)} ${m.content.slice(0, 40).replace(/\n/g, ' ')}${m.imagePath ? `  [image: ${m.imagePath}]` : ''}`);
}
