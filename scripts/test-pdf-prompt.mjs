// Check that the "PDF is special" guidance really landed in the prompt and the tool layer: run one
// turn against a simulated long PDF page (kind=pdf) and watch whether the model calls scope="viewport".
// Run: node scripts/test-pdf-prompt.mjs [question] [--selection=xxx]
import { readSettings } from '../server/settings.mjs';
import { requireRealConfig } from './require-real-config.mjs';

requireRealConfig();

const BASE = `http://127.0.0.1:${readSettings().port}`;

const argv = process.argv.slice(2);
const question = argv.find((a) => !a.startsWith('--')) ?? '解释选中的词';
const selection = argv.find((a) => a.startsWith('--selection='))?.slice('--selection='.length) ?? '';

// Build a body on the order of 15 pages
const para =
  'This paper surveys the use of Generative AI tools, such as ChatGPT and Claude, in computer science ' +
  'education, focusing on key aspects of accuracy, authenticity, and assessment. ';
const markdown = ('A Review of Generative AI in Computer Science Education\n\n' + para.repeat(20) + '\n\n').repeat(20);

const body = {
  page: {
    url: 'https://arxiv.org/pdf/2507.11543v1',
    title: '2507.11543v1.pdf',
    markdown,
    kind: 'pdf',
    pages: 15,
    selection,
    viewport: { text: '', scrollY: 0, height: 900, scrollHeight: 12000 },
  },
  text: question,
};

const res = await fetch(`${BASE}/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
if (!res.ok) {
  console.error('HTTP', res.status, await res.text());
  process.exit(1);
}

let buf = '';
const out = [];
let answer = '';
for await (const chunk of res.body) {
  buf += new TextDecoder().decode(chunk);
  const blocks = buf.split('\n\n');
  buf = blocks.pop() ?? '';
  for (const block of blocks) {
    const ev = block.match(/^event: (.+)$/m)?.[1];
    const raw = block.match(/^data: (.+)$/m)?.[1];
    if (!ev || !raw) continue;
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      continue;
    }
    if (ev === 'tool') {
      const mark = data.phase === 'start' ? '→' : data.ok === false ? '✗' : '✓';
      if (data.phase !== 'start') out.push(`${mark} ${data.label ?? data.name}${data.detail ? ' · ' + data.detail : ''}`);
      else out.push(`→ ${data.label ?? data.name} 开始`);
    } else if (ev === 'content') {
      answer += data.delta ?? '';
    } else if (ev === 'done') {
      out.push(`done · in=${data.usage?.input_tokens} out=${data.usage?.output_tokens}`);
    }
  }
}
console.log(out.length ? out.join('\n') : '(没有工具调用)');
console.log('--- 回答前 200 字 ---');
console.log(answer.slice(0, 200).replace(/\n+/g, ' '));

