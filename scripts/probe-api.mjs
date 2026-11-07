// 探测 DeepSeek 的流式返回形状：delta 里有哪些字段、stream_options 是否被接受、usage 何时出现。
// 用法: $env:DEEPSEEK_API_KEY=... ; node scripts/probe-api.mjs
const key = process.env.DEEPSEEK_API_KEY;
if (!key) {
  console.error('缺少 DEEPSEEK_API_KEY');
  process.exit(1);
}

const body = {
  model: process.env.PAGEASK_MODEL ?? 'deepseek-flash',
  messages: [{ role: 'user', content: '用一句话解释什么是 SSE，并用 $E=mc^2$ 举例。' }],
  stream: true,
  stream_options: { include_usage: true },
};

const res = await fetch('https://api.deepseek.com/chat/completions', {
  method: 'POST',
  headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

console.log('status', res.status, res.headers.get('content-type'));
if (!res.ok) {
  console.log('body:', await res.text());
  process.exit(1);
}

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
let lines = 0;
const kinds = new Set();
while (lines < 40) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') {
      console.log('[[DONE]]');
      lines = 999;
      break;
    }
    const j = JSON.parse(data);
    const d = j.choices?.[0]?.delta ?? {};
    for (const k of Object.keys(d)) kinds.add(k);
    if (j.usage) console.log('USAGE CHUNK:', JSON.stringify(j.usage));
    if (d.reasoning_content) process.stdout.write(`[R]${d.reasoning_content}`);
    else if (d.content) process.stdout.write(`[C]${d.content}`);
    if (++lines >= 40) break;
  }
}
console.log('\ndelta 出现过的字段:', [...kinds].join(', '));
await reader.cancel();
