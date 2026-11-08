// Probe the upstream stream shape: which delta fields exist, whether stream_options is accepted,
// when usage arrives. Reads baseUrl / model / key from ~/.config/pageask/settings.json.
// Usage: node scripts/probe-api.mjs
import { readSettings } from '../server/settings.mjs';

const cfg = readSettings();
const key = cfg.apiKey;
if (!key) {
  console.error('no API key in ~/.config/pageask/settings.json');
  process.exit(1);
}

const body = {
  model: cfg.model,
  messages: [{ role: 'user', content: '用一句话解释什么是 SSE，并用 $E=mc^2$ 举例。' }],
  stream: true,
  stream_options: { include_usage: true },
};

const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
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
