// Switch the matching target to a given color-scheme preference, evaluate JS, optionally screenshot (all in
// one CDP session, because Emulation.setEmulatedMedia is session-scoped and is cleared when the session drops).
// Usage: node scripts/cdp-dark.mjs <port> <URL substring> <expression> [screenshot path] [light|dark]
const [port = '9222', match = '', expr = '1+1', shotPath = '', scheme = 'dark'] = process.argv.slice(2);

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = list.find((t) => t.url.includes(match) || t.title.includes(match));
if (!target) {
  console.error(`没有匹配 "${match}" 的目标`);
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
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

await send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-color-scheme', value: scheme }],
});

const r = await send('Runtime.evaluate', {
  expression: expr,
  awaitPromise: true,
  returnByValue: true,
  userGesture: true,
});
if (r.result?.exceptionDetails) {
  console.error('异常:', r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
  process.exit(1);
}
const value = r.result?.result?.value;
console.log(typeof value === 'string' ? value : JSON.stringify(value));

if (shotPath) {
  const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(shotPath, Buffer.from(shot.result.data, 'base64'));
  console.log('截图: ' + shotPath);
}
ws.close();
