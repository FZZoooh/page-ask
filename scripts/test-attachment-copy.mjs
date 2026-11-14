// Regression: the copy_attachment tool. A text attachment must land in the conversation workspace as a
// UTF-8 file (downloadable through the artifact content endpoint), binaries (PDF/Office/images) are
// refused, oversized text hits the workspace limit, default names fall back to a valid workspace name,
// and overwrite only works when asked for. Run: node scripts/test-attachment-copy.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTestConfig } from './temp-config.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const steps = [];
const requests = [];
const upstream = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  if (!body.stream) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Copy' }] }] }));
    return;
  }
  requests.push(body);
  const step = steps.shift();
  assert.ok(step, 'scripted upstream step exists');
  const output = step.calls
    ? step.calls.map(({ name, args }, i) => ({
      type: 'function_call', call_id: `call_${requests.length}_${i}`, name, arguments: JSON.stringify(args),
    }))
    : [{ type: 'message', content: [{ type: 'output_text', text: step.text }] }];
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(`event: response.completed\ndata: ${JSON.stringify({
    type: 'response.completed', response: { id: `resp_${requests.length}`, status: 'completed', output },
  })}\n\n`);
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const probe = createServer();
await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const config = makeTestConfig({
  port, token: 'copy-test', state: 'off', baseUrl: `http://127.0.0.1:${upstream.address().port}`,
});
let child;
let exited;
const start = async () => {
  child = spawn(process.execPath, [join(root, 'server', 'index.mjs')], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  exited = once(child, 'exit');
  let diagnostic = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`backend startup timeout: ${diagnostic}`)), 10000);
    child.stdout.on('data', (chunk) => {
      diagnostic += chunk;
      if (diagnostic.includes('backend listening')) { clearTimeout(timer); resolve(); }
    });
    child.stderr.on('data', (chunk) => { diagnostic += chunk; });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`backend exited ${code}: ${diagnostic}`)); });
  });
  await ready;
};
const base = `http://127.0.0.1:${port}`;
const auth = { Authorization: `Bearer ${config.token}` };
const api = (path, options = {}) => fetch(`${base}${path}`, { ...options, headers: { ...auth, ...options.headers } });
const jsonPost = async (path, body) => {
  const res = await api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(res.status, 200);
  return res.json();
};
const upload = async (bytes, name) => {
  const res = await api('/attachments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name) },
    body: bytes,
  });
  assert.equal(res.status, 200);
  return res.json();
};
const page = { url: 'https://example.com/copy', title: 'Copy', markdown: 'Page text', kind: 'web' };
const chat = async (id, extra = {}) => {
  const res = await api('/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ page, text: 'Copy it', conversationId: id, locale: 'en-US', ...extra }),
  });
  assert.equal(res.status, 200);
  const frames = await res.text();
  assert.match(frames, /event: done/);
  assert.doesNotMatch(frames, /event: error/);
  return frames;
};
const outputs = (body) => body.input.filter((item) => item.type === 'function_call_output').map((item) => String(item.output));
const contentPath = (id, name) => `/conversations/${id}/files/${encodeURIComponent(name)}/content`;
const wsDir = (id) => join(config.dataDir, 'workspaces', createHash('sha256').update(id).digest('hex'));
const stop = async () => {
  if (child && child.exitCode === null) {
    const res = await api('/api/shutdown', { method: 'POST' });
    assert.equal(res.status, 202);
    await exited;
  }
};

const CSV_BYTES = Buffer.from('id,name\n1,RightHandMan\n2,复制\n', 'utf8');
const CSV2_BYTES = Buffer.from('id,name\n3,replaced\n', 'utf8');
// UTF-16LE with BOM: the copy must transcode, not store the original bytes.
const LEGACY_BYTES = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('品名,数量\n苹果,3\n', 'utf16le')]);
const LEGACY_TEXT = '品名,数量\n苹果,3\n';
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const CFG_BYTES = Buffer.from('alpha=1\n', 'utf8');
const BIG_BYTES = Buffer.from(`${'x'.repeat(120)}\n`.repeat(14000), 'utf8'); // 1.68 MB > 1 MiB workspace file limit

try {
  await start();
  const csv = await upload(CSV_BYTES, 'notes.csv');
  const csv2 = await upload(CSV2_BYTES, 'notes2.csv');
  const legacy = await upload(LEGACY_BYTES, 'legacy.csv');
  const png = await upload(PNG_BYTES, 'shot.png');
  const cfg = await upload(CFG_BYTES, "it's final.cfg");
  const big = await upload(BIG_BYTES, 'big.log');
  const pdf = await upload(readFileSync(join(root, 'test', 'sample.pdf')), 'paper.pdf');

  /* ---------- happy path: text attachment lands in the workspace ---------- */
  const a = await jsonPost('/conversations', { url: page.url });
  steps.push({ calls: [{ name: 'copy_attachment', args: { file_id: csv.id } }] }, { text: '<artifact name="notes.csv"/>' });
  const frames = await chat(a.id, { attachments: [csv.id] });
  assert.match(frames, /"name":"copy_attachment"/);
  assert.match(frames, /"label":"Copy Attachment"/);
  const first = requests.at(-2);
  assert.ok(first.tools.some((item) => item.name === 'copy_attachment'), 'copy_attachment is offered');
  assert.match(first.instructions, /copy_attachment: copy a plain-text attachment/);
  const copied = outputs(requests.at(-1));
  assert.equal(copied.length, 1);
  assert.ok(copied[0].startsWith('<untrusted_content source="workspace">'), copied[0]);
  assert.ok(copied[0].endsWith('</untrusted_content>'));
  assert.match(copied[0], /Copied "notes\.csv" into the workspace as notes\.csv/);
  assert.match(copied[0], /To show a downloadable card/);
  assert.ok(copied[0].length <= 8000);
  const savedPath = join(wsDir(a.id), 'notes.csv');
  assert.ok(existsSync(savedPath), 'workspace file exists');
  assert.deepEqual(readFileSync(savedPath), CSV_BYTES, 'UTF-8 bytes are copied as is');
  const download = await api(contentPath(a.id, 'notes.csv'));
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), CSV_BYTES);
  assert.equal(download.headers.get('content-type'), 'application/octet-stream');
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');

  /* ---------- exists / overwrite / explicit name ---------- */
  steps.push({ calls: [
    { name: 'copy_attachment', args: { file_id: csv.id } },
    { name: 'copy_attachment', args: { file_id: csv2.id, name: 'folder/notes.csv' } },
    { name: 'copy_attachment', args: { file_id: csv2.id, name: 'notes.csv', overwrite: true } },
  ] }, { text: 'Done' });
  await chat(a.id, { attachments: [csv2.id] });
  const second = outputs(requests.at(-1)).slice(-3);
  assert.equal(second.length, 3);
  assert.match(second[0], /workspace\.exists/);
  assert.match(second[1], /workspace\.invalid_name/);
  assert.match(second[2], /Copied "notes2\.csv" into the workspace as notes\.csv/);
  assert.deepEqual(readFileSync(savedPath), CSV2_BYTES, 'overwrite=true replaces the file');

  /* ---------- refusals: unknown id, image, binary PDF, oversized text ---------- */
  // Failures and successes interleave on purpose: 3 consecutive failures trip the tool breaker
  // and the remaining calls would get breakBody instead of their own result.
  const b = await jsonPost('/conversations', { url: page.url });
  steps.push({ calls: [
    { name: 'copy_attachment', args: { file_id: 'f_deadbeefcafe' } },
    { name: 'copy_attachment', args: { file_id: cfg.id } },
    { name: 'copy_attachment', args: { file_id: png.id } },
    { name: 'copy_attachment', args: { file_id: legacy.id } },
    { name: 'copy_attachment', args: { file_id: pdf.id } },
    { name: 'copy_attachment', args: { file_id: big.id } },
  ] }, { text: 'Done' });
  await chat(b.id, { attachments: [png.id, pdf.id, big.id, cfg.id, legacy.id] });
  const mixed = outputs(requests.at(-1)).slice(-6);
  assert.equal(mixed.length, 6);
  assert.match(mixed[0], /No attachment with file_id "f_deadbeefcafe"/);
  assert.match(mixed[0], /source="file_list"/);
  assert.match(mixed[1], /Copied "it's final\.cfg" into the workspace as it-s final\.txt/);
  assert.match(mixed[2], /This attachment is an image/);
  assert.match(mixed[3], /Copied "legacy\.csv" into the workspace as legacy\.csv/);
  assert.match(mixed[4], /binary and cannot be copied/);
  assert.match(mixed[4], /read_file/);
  assert.match(mixed[5], /workspace\.too_large/);
  assert.deepEqual(
    readFileSync(join(wsDir(b.id), 'it-s final.txt')),
    CFG_BYTES,
    'unusable names fall back to a valid workspace name',
  );
  assert.deepEqual(
    readFileSync(join(wsDir(b.id), 'legacy.csv')),
    Buffer.from(LEGACY_TEXT, 'utf8'),
    'UTF-16 source is transcoded to UTF-8',
  );

  /* ---------- file missing on disk ---------- */
  const gone = await upload(Buffer.from('soon gone\n', 'utf8'), 'gone.txt');
  unlinkSync(join(config.dataDir, 'attachments', `${gone.id}.txt`));
  steps.push({ calls: [{ name: 'copy_attachment', args: { file_id: gone.id } }] }, { text: 'Done' });
  await chat(b.id, { attachments: [gone.id] });
  assert.match(outputs(requests.at(-1)).slice(-1)[0], /missing on disk/);

  await stop();
  console.log('attachment copy: all checks passed');
} finally {
  try {
    await stop();
  } finally {
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    config.cleanup();
  }
}
