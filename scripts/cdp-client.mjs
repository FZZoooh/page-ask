// Shared minimal CDP client for the dev scripts. The three cdp-*.mjs tools used to copy this
// block; one copy means one timeout/error policy and one place to fix a stuck socket.
const CDP_TIMEOUT_MS = 10_000;

/** Connect to the target whose URL or title contains `match`; throws when none/Ambiguous. */
export async function connectCdp(port, match) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(CDP_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`CDP target list failed: HTTP ${res.status}`);
  const list = await res.json();
  const target = list.find((t) => (t.url ?? '').includes(match) || (t.title ?? '').includes(match));
  if (!target?.webSocketDebuggerUrl) throw new Error(`no CDP target matching "${match}"`);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  const rejectAll = (err) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    pending.clear();
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    const item = pending.get(m.id);
    if (!item) return;
    pending.delete(m.id);
    clearTimeout(item.timer);
    if (m.error) item.reject(new Error(m.error.message ?? 'CDP error'));
    else item.resolve(m);
  };
  let connectReject = null;
  ws.onclose = () => {
    const err = new Error('CDP socket closed');
    connectReject?.(err);
    rejectAll(err);
  };
  ws.onerror = () => {
    const err = new Error('CDP socket error');
    connectReject?.(err);
    rejectAll(err);
  };

  await new Promise((resolve, reject) => {
    connectReject = reject;
    const timer = setTimeout(() => reject(new Error('CDP connect timed out')), CDP_TIMEOUT_MS);
    ws.onopen = () => {
      clearTimeout(timer);
      connectReject = null;
      resolve();
    };
  });

  /** Resolve with the protocol message; reject on protocol error, socket close, or 10 s silence. */
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, CDP_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });

  return {
    send,
    close: () => ws.close(),
    url: target.url,
  };
}
