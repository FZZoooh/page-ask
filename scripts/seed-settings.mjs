// 通过 CDP 把扩展设置写进 storage.local。
//
// 只写「后端地址」这类扩展偏好：API Key 属于后端，真源是
// ~/.config/pageask/settings.json，绝不能落到浏览器 storage 里。
//
// 用法: node scripts/seed-settings.mjs [debugPort]
const port = process.argv[2] ?? '9358';

const settings = {
  backendUrl: process.env.PAGEASK_BACKEND_URL ?? 'http://127.0.0.1:8787',
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

// 顺手清掉旧版脚本写进去的 v1（里面可能带明文 Key）
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
