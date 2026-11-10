// Probe the Responses API: images inside tool results, and replaying reasoning+tool history.
// Reads baseUrl / model / key from ~/.config/righthandman/settings.json.
// Usage: PAGEASK_ALLOW_REAL=1 node scripts/probe-responses.mjs
import { readSettings } from '../server/settings.mjs';
import { withV1 } from '../server/upstream.mjs';
import { requireRealConfig } from './require-real-config.mjs';

// This script spends real tokens, so make the opt-in explicit before touching the config.
requireRealConfig();
const cfg = readSettings();
const KEY = cfg.apiKey;
const BASE = withV1(cfg.baseUrl);
const MODEL = cfg.model;
if (!KEY) {
  console.error('no API key in ~/.config/righthandman/settings.json');
  process.exit(1);
}

const RED =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function post(body) {
  const res = await fetch(`${BASE}/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* error page, or a streamed body */
  }
  return { status: res.status, text, json };
}

function extractText(json) {
  const parts = [];
  for (const item of json.output ?? []) {
    if (item.type !== 'message') continue;
    for (const c of item.content ?? []) if (typeof c.text === 'string') parts.push(c.text);
  }
  return parts.join('');
}

function summarize(json) {
  if (!json) return '(no json)';
  if (json.error) return `ERROR ${JSON.stringify(json.error).slice(0, 300)}`;
  const out = json.output ?? [];
  const kinds = out.map((o) => o.type).join(',');
  const text = extractText(json).replace(/\s+/g, ' ').slice(0, 200);
  const u = json.usage;
  const usage = u ? `in=${u.input_tokens} out=${u.output_tokens} reasoning=${u.output_tokens_details?.reasoning_tokens}` : '';
  return `types=[${kinds}] text="${text}" ${usage}`;
}

const userMsg = (t) => ({ role: 'user', content: [{ type: 'input_text', text: t }] });

console.log('=== 2. 函数工具 + function_call_output 里带图片 ===');
{
  const tools = [
    {
      type: 'function',
      name: 'screenshot',
      description: '截取用户当前画面',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  ];
  const first = await post({ model: MODEL, input: [userMsg('截个图，告诉我画面是什么颜色。')], tools });
  console.log('turn1', first.status, first.json ? summarize(first.json) : first.text.slice(0, 300));
  const call = first.json?.output?.find((o) => o.type === 'function_call');
  if (!call) process.exit(0);

  const second = await post({
    model: MODEL,
    input: [
      userMsg('截个图，告诉我画面是什么颜色。'),
      ...first.json.output,
      {
        type: 'function_call_output',
        call_id: call.call_id,
        output: [
          { type: 'input_text', text: '截图如下。' },
          { type: 'input_image', image_url: RED, detail: 'low' },
        ],
      },
    ],
    tools,
  });
  console.log('turn2', second.status, second.json ? summarize(second.json) : second.text.slice(0, 400));
}

console.log('\n=== 3. 思考+工具：历史里不回传 reasoning item ===');
{
  const tools = [
    {
      type: 'function',
      name: 'add',
      description: '把两个整数相加',
      parameters: {
        type: 'object',
        properties: { a: { type: 'integer' }, b: { type: 'integer' } },
        required: ['a', 'b'],
        additionalProperties: false,
      },
    },
  ];
  const first = await post({ model: MODEL, input: [userMsg('用工具算 17 + 25。')], tools });
  console.log('turn1', first.status, first.json ? summarize(first.json) : first.text.slice(0, 200));
  const call = first.json?.output?.find((o) => o.type === 'function_call');
  if (!call) process.exit(0);

  const kept = first.json.output.filter((o) => o.type !== 'reasoning');
  const second = await post({
    model: MODEL,
    input: [
      userMsg('用工具算 17 + 25。'),
      ...kept,
      { type: 'function_call_output', call_id: call.call_id, output: '42' },
    ],
    tools,
  });
  console.log('turn2(丢弃 reasoning)', second.status, second.json ? summarize(second.json) : second.text.slice(0, 400));

  // Try once more: hand the reasoning items back verbatim
  const third = await post({
    model: MODEL,
    input: [
      userMsg('用工具算 17 + 25。'),
      ...first.json.output,
      { type: 'function_call_output', call_id: call.call_id, output: '42' },
    ],
    tools,
  });
  console.log('turn2(回传 reasoning)', third.status, third.json ? summarize(third.json) : third.text.slice(0, 400));
}
