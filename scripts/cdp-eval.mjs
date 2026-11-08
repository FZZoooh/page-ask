// Generic CDP tool: evaluate a JS expression in the target whose URL matches.
// Usage: node scripts/cdp-eval.mjs <port> <URL substring> <expression>
// Example: node scripts/cdp-eval.mjs 9333 sidepanel.html "document.title"
const [port = '9222', match = '', expr = '1+1'] = process.argv.slice(2);

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = list.find((t) => t.url.includes(match) || t.title.includes(match));
if (!target) {
  console.error(
    `没有匹配 "${match}" 的目标，现有目标：\n` + list.map((t) => `${t.type}\t${t.url}`).join('\n'),
  );
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
ws.close();
