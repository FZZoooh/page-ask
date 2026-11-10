// Write extension settings into storage.local over CDP.
//
// Only extension preferences such as the backend URL belong here: the API key is the backend's,
// its source of truth is ~/.config/righthandman/settings.json, and it must never reach browser storage.
//
// Usage: node scripts/seed-settings.mjs [debugPort]
import { readSettings } from '../server/settings.mjs';

const port = process.argv[2] ?? '9358';
// The backend port comes from settings.json, so the seeded extension points at the real backend
const settings = {
  backendUrl: `http://127.0.0.1:${readSettings().port}`,
  verbose: true,
};

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const sw = list.find((t) => t.type === 'service_worker' && t.url.includes('background.js'));
if (!sw) {
  console.error('找不到扩展的 service worker，目标列表：\n' + list.map((t) => `${t.type} ${t.url}`).join('\n'));
  process.exit(1);
}

const ws = new WebSocket(sw.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  const cb = pending.get(m.id);
  if (cb) {
    pending.delete(m.id);
    cb(m);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

// Also drop the v1 key written by older scripts (it may still hold a plaintext key)
const expr = `(async () => {
  await chrome.storage.local.remove('pageask.settings.v1');
  await chrome.storage.local.set({ 'pageask.settings.v2': ${JSON.stringify(settings)} });
  return 'ok';
})()`;
const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
const err = r.result?.exceptionDetails;
if (err) {
  console.error('写入失败:', err.exception?.description ?? err.text);
  process.exit(1);
}
console.log('已写入扩展设置：backendUrl=%s（未写 API Key）', settings.backendUrl);
ws.close();
