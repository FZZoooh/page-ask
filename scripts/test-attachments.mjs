// Regression: attachment upload/sniffing/error codes, binding to /chat, replay as <attachment/> tags plus
// input_image, the read_file tool, edits that add/remove files, recovery back to pending, and file cleanup
// when a pending upload or a whole conversation is deleted. Run: node scripts/test-attachments.mjs
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8, zipSync } from 'fflate';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = mkdtempSync(join(tmpdir(), 'pageask-att-home-'));
const data = mkdtempSync(join(tmpdir(), 'pageask-att-data-'));
const attDir = join(data, 'attachments');
mkdirSync(join(home, '.config', 'righthandman'), { recursive: true });

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !extra ? '' : ` — ${extra}`}`);
  if (!ok) failures += 1;
};

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });

const readJsonBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve({});
      }
    });
  });

// Each streamed request takes the next scripted step: a tool call, a text answer, or an upstream failure.
const script = [];
const streamBodies = [];
const sse = (res, event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
const upstreamPort = await freePort();
const upstream = createServer(async (req, res) => {
  const body = await readJsonBody(req);
  if (!req.url.endsWith('/responses')) return res.writeHead(404).end();
  if (!body.stream) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'resp_title', output: [{ type: 'message', content: [{ type: 'output_text', text: 'T' }] }] }));
    return;
  }
  streamBodies.push(body);
  const step = script.shift() ?? { text: 'ok' };
  if (step.fail) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'boom' } }));
    return;
  }
  const n = streamBodies.length;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  if (step.call) {
    sse(res, {
      type: 'response.completed',
      response: {
        id: `resp_${n}`,
        status: 'completed',
        output: [{ type: 'function_call', call_id: `call_${n}`, name: 'read_file', arguments: JSON.stringify(step.call) }],
      },
    });
  } else {
    sse(res, { type: 'response.output_text.delta', delta: step.text });
    sse(res, {
      type: 'response.completed',
      response: { id: `resp_${n}`, status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: step.text }] }] },
    });
  }
  res.end();
});
await new Promise((r) => upstream.listen(upstreamPort, '127.0.0.1', r));

const port = await freePort();
const token = 'att-token';
writeFileSync(
  join(home, '.config', 'righthandman', 'settings.json'),
  JSON.stringify({
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    model: 'fake',
    apiKey: 'test-key',
    state: 'off',
    port,
    token,
    dataDir: data,
  }),
);

const child = spawn(process.execPath, [join(root, 'server', 'index.mjs')], {
  env: { ...process.env, USERPROFILE: home, HOME: home },
  stdio: 'ignore',
});

const base = `http://127.0.0.1:${port}`;
const auth = { Authorization: `Bearer ${token}` };
const waitUp = async () => {
  for (let i = 0; i < 80; i += 1) {
    try {
      const r = await fetch(`${base}/health/live`);
      if (r.ok) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

const upload = async (bytes, name) => {
  const res = await fetch(`${base}/attachments`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name) },
    body: bytes,
  });
  return { status: res.status, body: await res.json() };
};

const page = { url: 'https://example.com/att', title: 't', markdown: '正文', kind: 'web' };
const postChat = (body) =>
  fetch(`${base}/chat`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ page, ...body }),
  });
const chatJson = async (body) => {
  const res = await postChat(body);
  return { status: res.status, body: await res.json() };
};
const chatSse = async (body) => {
  const res = await postChat(body);
  const text = await res.text();
  const meta = /event: meta\ndata: (.*)\n/.exec(text);
  return { status: res.status, text, meta: meta ? JSON.parse(meta[1]) : null };
};
const getConv = (id) => fetch(`${base}/conversations/${encodeURIComponent(id)}`, { headers: auth }).then((r) => r.json());
const fileCount = () => readdirSync(attDir).filter((f) => !f.startsWith('.')).length;

/** The user message items an upstream request carried, flattened to their parts */
const userParts = (body) => (body?.input ?? []).filter((i) => i.role === 'user').map((i) => i.content ?? []);
const textOf = (parts) => parts.filter((p) => p.type === 'input_text').map((p) => p.text).join('\n');
const toolOutputs = (body) => (body?.input ?? []).filter((i) => i.type === 'function_call_output').map((i) => String(i.output));

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const DOCX = Buffer.from(
  zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types/>'),
    'word/document.xml': strToU8(
      '<?xml version="1.0"?><w:document xmlns:w="w"><w:body>' +
        '<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>季度报告</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>DOCX_MARKER revenue grew</w:t></w:r></w:p>' +
        '</w:body></w:document>',
    ),
  }),
);
const TEXT = Buffer.from('alpha line\nNEEDLE in the haystack\nomega line\n', 'utf8');

try {
  check('backend started', await waitUp());

  /* ---------- upload: sniffing and error codes ---------- */
  const txt = await upload(TEXT, 'notes.txt');
  check('text upload succeeds', txt.status === 200 && txt.body.format === 'text' && txt.body.kind === 'document', JSON.stringify(txt));
  check('text upload reports extracted chars', txt.body.chars === TEXT.toString('utf8').length, String(txt.body.chars));

  const docx = await upload(DOCX, 'C:\\fake\\季度报告.docx');
  check('docx upload is sniffed as docx', docx.status === 200 && docx.body.format === 'docx', JSON.stringify(docx));
  check('CJK file name survives and loses its path', docx.body.name === '季度报告.docx', docx.body.name);

  const png = await upload(PNG, 'shot.bmp');
  check('png is sniffed as an image despite its name', png.status === 200 && png.body.kind === 'image' && png.body.mime === 'image/png', JSON.stringify(png));

  const binary = await upload(Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0x00]), 'blob.bin');
  check('binary upload → 415 attachment.unsupported', binary.status === 415 && binary.body.code === 'attachment.unsupported', JSON.stringify(binary));

  const empty = await upload(Buffer.from('   \n\t '), 'blank.txt');
  check('whitespace-only text → attachment.no_text', empty.status === 415 && empty.body.code === 'attachment.no_text', JSON.stringify(empty));

  const zip = await upload(Buffer.from(zipSync({ 'a.txt': strToU8('x') })), 'a.zip');
  check('a non-Office zip → attachment.unsupported', zip.status === 415 && zip.body.code === 'attachment.unsupported', JSON.stringify(zip));

  const huge = await upload(Buffer.alloc(20 * 1024 * 1024 + 1, 0x61), 'huge.txt');
  check('over 20 MB → 413 attachment.too_large', huge.status === 413 && huge.body.code === 'attachment.too_large', JSON.stringify(huge));
  check('too_large carries the limit', huge.body.params?.limitMb === 20, JSON.stringify(huge.body.params));

  const anon = await fetch(`${base}/attachments`, { method: 'POST', body: TEXT });
  check('upload without the token is rejected', anon.status === 401, String(anon.status));
  check('only accepted uploads left files on disk', fileCount() === 3, String(fileCount()));

  /* ---------- content + pending delete ---------- */
  const noAuth = await fetch(`${base}/attachments/${png.body.id}/content`);
  check('content needs the token', noAuth.status === 401, String(noAuth.status));
  const pngRes = await fetch(`${base}/attachments/${png.body.id}/content`, { headers: auth });
  const pngBack = Buffer.from(await pngRes.arrayBuffer());
  check('image content comes back byte-identical', pngRes.status === 200 && pngBack.equals(PNG));
  check('image content keeps its image type', pngRes.headers.get('content-type') === 'image/png', pngRes.headers.get('content-type'));
  const txtRes = await fetch(`${base}/attachments/${txt.body.id}/content`, { headers: auth });
  check('document content is opaque bytes', txtRes.headers.get('content-type') === 'application/octet-stream');
  check('content is nosniff', txtRes.headers.get('x-content-type-options') === 'nosniff');
  await txtRes.arrayBuffer();

  const temp = await upload(Buffer.from('throw me away'), 'temp.txt');
  const del = await fetch(`${base}/attachments/${temp.body.id}`, { method: 'DELETE', headers: auth });
  check('a pending upload can be deleted', del.status === 200, String(del.status));
  const delAgain = await fetch(`${base}/attachments/${temp.body.id}`, { method: 'DELETE', headers: auth });
  check('deleting it again → 404', delAgain.status === 404);
  check('its file is gone', fileCount() === 3, String(fileCount()));

  /* ---------- /chat validation ---------- */
  const created = await fetch(`${base}/conversations`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: page.url, title: 't' }),
  }).then((r) => r.json());

  const many = await chatJson({ conversationId: created.id, text: 'x', attachments: Array.from({ length: 11 }, (_, i) => `f_${i}`) });
  check('11 attachments → attachment.too_many', many.status === 400 && many.body.code === 'attachment.too_many', JSON.stringify(many));
  const unknown = await chatJson({ conversationId: created.id, text: 'x', attachments: ['f_nope'] });
  check('unknown id → attachment.not_found', unknown.status === 400 && unknown.body.code === 'attachment.not_found', JSON.stringify(unknown));
  const bad = await chatJson({ conversationId: created.id, text: 'x', attachments: [42] });
  check('non-string ids are a bad request', bad.status === 400, JSON.stringify(bad));
  const blank = await chatJson({ conversationId: created.id, text: '', attachments: [] });
  check('no text and no files → chat.empty_text', blank.status === 400 && blank.body.code === 'chat.empty_text', JSON.stringify(blank));
  check('failed requests bound nothing', (await getConv(created.id)).messages?.length === 0);

  /* ---------- attachment-only turn with a read_file call ---------- */
  script.push({ call: { file_id: txt.body.id, query: 'NEEDLE' } }, { text: '读完了' });
  const first = await chatSse({ conversationId: created.id, text: '', attachments: [txt.body.id, png.body.id] });
  check('attachment-only turn completes', first.status === 200 && first.text.includes('event: done') && !first.text.includes('event: error'), first.text.slice(-300));
  const firstReq = streamBodies[0];
  const firstUser = userParts(firstReq).at(-1) ?? [];
  check('the user item lists the text file as a tag', textOf(firstUser).includes(`<attachment file_id="${txt.body.id}" name="notes.txt" type="text"`), textOf(firstUser));
  check('the user item tags the image', textOf(firstUser).includes(`<attachment file_id="${png.body.id}" name="shot.bmp" type="image"/>`), textOf(firstUser));
  check('the image rides along as input_image', firstUser.some((p) => p.type === 'input_image' && String(p.image_url).startsWith('data:image/png;base64,')));
  check('read_file is offered as a tool', (firstReq.tools ?? []).some((t) => t.name === 'read_file'));
  const readOut = toolOutputs(streamBodies[1]).join('\n');
  check('read_file returns the matching line', readOut.includes('NEEDLE in the haystack'), readOut.slice(0, 300));
  check('read_file output is wrapped as untrusted', readOut.includes('<untrusted_content') && readOut.includes(`file_id="${txt.body.id}"`), readOut.slice(0, 300));
  check('the tool SSE event names read_file', /event: tool\ndata: .*read_file/.test(first.text));

  const conv1 = await getConv(created.id);
  const u1 = conv1.messages?.[0];
  check('the stored user message carries both attachments in order', JSON.stringify(u1?.attachments?.map((a) => a.id)) === JSON.stringify([txt.body.id, png.body.id]), JSON.stringify(u1?.attachments));
  check('stored metadata hides the file path and text', u1?.attachments?.every((a) => !('file' in a) && !('text' in a)));

  const rebind = await chatJson({ conversationId: created.id, text: 'again', attachments: [txt.body.id] });
  check('a bound attachment cannot be bound again', rebind.status === 400 && rebind.body.code === 'attachment.not_found', JSON.stringify(rebind));
  const delBound = await fetch(`${base}/attachments/${txt.body.id}`, { method: 'DELETE', headers: auth });
  check('a bound attachment cannot be deleted directly', delBound.status === 404);

  /* ---------- later turn: earlier files stay in the replay ---------- */
  script.push({ call: { file_id: 'f_missing' } }, { text: '第二答' });
  const second = await chatSse({ conversationId: created.id, text: '再看看' });
  check('second turn completes', second.text.includes('event: done'), second.text.slice(-300));
  const secondReq = streamBodies[2];
  const replayed = userParts(secondReq);
  check('the earlier attachment tags replay byte-identically', textOf(replayed[0] ?? []) === textOf(firstUser), textOf(replayed[0] ?? []));
  check('the earlier image is replayed', (replayed[0] ?? []).some((p) => p.type === 'input_image'));
  const missingOut = toolOutputs(streamBodies[3]).at(-1) ?? '';
  check('an unknown file_id lists the available attachments', missingOut.includes(txt.body.id) && missingOut.includes('notes.txt'), missingOut);

  /* ---------- edit: drop the image, add the docx ---------- */
  const beforeEdit = fileCount();
  script.push({ call: { file_id: docx.body.id } }, { text: '改后答' });
  const edited = await chatSse({ conversationId: created.id, text: '只看文档', editMessageId: u1.id, attachments: [txt.body.id, docx.body.id] });
  check('edit turn completes', edited.status === 200 && edited.text.includes('event: done'), edited.text.slice(-300));
  const conv2 = await getConv(created.id);
  const u2 = conv2.messages?.[0];
  check('edit keeps the message id', u2?.id === u1.id);
  check('edit rebinds to the new attachment list', JSON.stringify(u2?.attachments?.map((a) => a.id)) === JSON.stringify([txt.body.id, docx.body.id]), JSON.stringify(u2?.attachments));
  check('the dropped image file is deleted', !readdirSync(attDir).some((f) => f.startsWith(png.body.id)) && fileCount() === beforeEdit - 1, readdirSync(attDir).join(','));
  const editReq = streamBodies[4];
  check('the edited turn no longer sends the image', !userParts(editReq).flat().some((p) => p.type === 'input_image'));
  const docxOut = toolOutputs(streamBodies[5]).at(-1) ?? '';
  check('read_file extracts docx text', docxOut.includes('DOCX_MARKER revenue grew') && docxOut.includes('# 季度报告'), docxOut.slice(0, 300));

  const regen = await chatSse({ conversationId: created.id, regenerate: true, attachments: [] });
  check('regenerate ignores an attachments field', regen.text.includes('event: done') && (await getConv(created.id)).messages?.[0]?.attachments?.length === 2);

  /* ---------- recover: a failed turn hands its files back as pending ---------- */
  const conv3 = await fetch(`${base}/conversations`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: page.url, title: 'r' }),
  }).then((r) => r.json());
  const lost = await upload(Buffer.from('recover me'), 'lost.txt');
  script.push({ fail: true });
  const failed = await chatSse({ conversationId: conv3.id, text: '会失败', attachments: [lost.body.id] });
  check('the upstream failure surfaces as an SSE error', failed.text.includes('event: error'), failed.text.slice(-300));
  const recovered = await fetch(`${base}/conversations/${conv3.id}/recover`, { method: 'POST', headers: auth });
  const recoveredBody = await recovered.json();
  check('recover returns the question', recovered.status === 200 && recoveredBody.text === '会失败', JSON.stringify(recoveredBody));
  check('recover returns its attachments', recoveredBody.attachments?.[0]?.id === lost.body.id, JSON.stringify(recoveredBody.attachments));
  const lostDel = await fetch(`${base}/attachments/${lost.body.id}`, { method: 'DELETE', headers: auth });
  check('a recovered attachment is pending again (deletable)', lostDel.status === 200, String(lostDel.status));

  /* ---------- deleting the conversation removes its files ---------- */
  const keptIds = [txt.body.id, docx.body.id];
  check('the conversation files exist before delete', keptIds.every((id) => readdirSync(attDir).some((f) => f.startsWith(id))));
  const delConv = await fetch(`${base}/conversations/${created.id}`, { method: 'DELETE', headers: auth });
  check('conversation delete succeeds', delConv.status === 200);
  check('its attachment files are gone', !keptIds.some((id) => readdirSync(attDir).some((f) => f.startsWith(id))), readdirSync(attDir).join(','));
  const gone = await fetch(`${base}/attachments/${txt.body.id}/content`, { headers: auth });
  check('content of a deleted attachment → 404', gone.status === 404);
  check('no attachment file is left behind', fileCount() === 0, readdirSync(attDir).join(','));
  check('the attachments dir itself survives', existsSync(attDir));
} finally {
  child.kill();
  await new Promise((r) => {
    if (child.exitCode !== null) return r();
    child.once('exit', r);
    setTimeout(r, 3000);
  });
  upstream.closeAllConnections?.();
  await new Promise((r) => upstream.close(r));
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* Windows may hold the sqlite handle briefly; the temp dir is harmless */
  }
}

console.log(failures ? `\n${failures} failure(s)` : '\nall good');
process.exitCode = failures ? 1 : 0;
