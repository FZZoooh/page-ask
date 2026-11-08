// Attach to the extension's service worker over CDP to check API availability / gesture limits.
// This talks to a live browser, so require the real-run opt-in.
// Usage: PAGEASK_ALLOW_REAL=1 node scripts/probe-sw.mjs [port]
import { requireRealConfig } from './require-real-config.mjs';

requireRealConfig();

const port = process.argv[2] ?? '9222';
const base = `http://127.0.0.1:${port}`;
const list = await (await fetch(`${base}/json/list`)).json();
const sw = list.find((t) => t.type === 'service_worker' && t.url.includes('background.js'));
if (!sw) {
  console.log('no service worker found. targets:\n' + list.map((t) => `${t.type} ${t.url}`).join('\n'));
  process.exit(1);
}
console.log('SW target:', sw.url);

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

const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) {
    return 'THROW: ' + (r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text ?? '');
  }
  return r.result?.result?.value;
};

console.log('typeof chrome.contextMenus =', await ev('typeof chrome.contextMenus'));
console.log('typeof chrome.sidePanel   =', await ev('typeof chrome.sidePanel'));
console.log('commands.getAll ->', await ev(`new Promise((res) => chrome.commands.getAll((c) => res(JSON.stringify(c))))`));
console.log(
  'sidePanel.open 无手势 ->',
  await ev(
    `chrome.sidePanel.open({ windowId: 1 }).then(() => 'resolved (不该发生)').catch((e) => 'rejected: ' + e.message)`,
  ),
);
ws.close();
