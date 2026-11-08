// Probe the upstream Responses API stream shape: which delta events exist and when usage arrives.
// Reads baseUrl / model / key from ~/.config/pageask/settings.json and talks to the real upstream.
// Usage: PAGEASK_ALLOW_REAL=1 node scripts/probe-api.mjs
import { readSettings } from '../server/settings.mjs';
import { withV1 } from '../server/upstream.mjs';
import { requireRealConfig } from './require-real-config.mjs';

requireRealConfig();

const cfg = readSettings();
const key = cfg.apiKey;
if (!key) {
  console.error('no API key in ~/.config/pageask/settings.json');
  process.exit(1);
}

const body = {
  model: cfg.model,
  stream: true,
  store: false,
  instructions: 'Answer in one short sentence.',
  input: [{ role: 'user', content: [{ type: 'input_text', text: '用一句话解释什么是 SSE。' }] }],
};

const res = await fetch(`${withV1(cfg.baseUrl)}/responses`, {
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
let events = 0;
const kinds = new Set();
while (events < 80) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
  let idx;
  while ((idx = buf.indexOf('\n\n')) >= 0) {
    const frame = buf.slice(0, idx);
    buf = buf.slice(idx + 2);
    let name = '';
    let data = '';
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!name && !data) continue;
    kinds.add(name || '(data-only)');
    let parsed = null;
    try {
      parsed = data ? JSON.parse(data) : null;
    } catch {
      console.log('non-JSON frame:', frame.slice(0, 200));
      continue;
    }
    if (name === 'response.output_text.delta' && parsed?.delta) process.stdout.write(`[C]${parsed.delta}`);
    else if (name === 'response.reasoning_text.delta' && parsed?.delta) process.stdout.write(`[R]${parsed.delta}`);
    else if (name === 'response.completed') {
      console.log('\nUSAGE:', JSON.stringify(parsed?.response?.usage ?? null));
      console.log('OUTPUT TYPES:', (parsed?.response?.output ?? []).map((i) => i.type).join(', '));
    } else if (name === 'response.failed' || name === 'error') {
      console.log('\nFAILED:', data.slice(0, 500));
    }
    if (++events >= 80) break;
  }
}
console.log('\nevents:', [...kinds].join(', '));
await reader.cancel();
