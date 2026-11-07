// 往匹配目标发一个真实按键（走 Input.dispatchKeyEvent，和用户按键等价）。
// 用法: node scripts/cdp-key.mjs <端口> <URL 子串> <键名> [次数]
// 例:   node scripts/cdp-key.mjs 9373 sidepanel.html Backspace 1
const [port = '9222', match = '', key = 'Backspace', times = '1'] = process.argv.slice(2);

const KEYS = {
  Backspace: { code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8, key: 'Backspace' },
  ArrowLeft: { code: 'ArrowLeft', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37, key: 'ArrowLeft' },
  ArrowRight: { code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39, key: 'ArrowRight' },
  Delete: { code: 'Delete', windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46, key: 'Delete' },
};

const spec = KEYS[key];
// 不是预置按键也不是单字符 → 报错；单字符走 char 通道（等价于用户敲那个键）
const isChar = !spec && [...key].length === 1;
if (!spec && !isChar) {
  console.error('未知按键: ' + key + '，可用: ' + Object.keys(KEYS).join(', ') + '，或给一个字符');
  process.exit(1);
}

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

const n = Math.max(1, Number(times) || 1);
for (let i = 0; i < n; i++) {
  if (isChar) {
    // 真实字符输入：先 keyDown 再 insertText（等价于用户敲这个字符）
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: key, key });
    await send('Input.insertText', { text: key });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key });
  } else {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', ...spec });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...spec });
  }
}
console.log(`已发送 ${key} × ${n}`);
ws.close();
