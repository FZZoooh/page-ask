/**
 * 配置页 HTML（`GET /settings`）。刻意不用任何构建步骤：一个字符串、内联样式和内联脚本，
 * 打开就能改 Key / 上游地址 / 模型，保存后下一个请求立刻生效（后端每次都重读 settings.json）。
 */

export function settingsPageHtml({ version }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PageAsk 配置</title>
<style>
  :root {
    --bg: #ffffff; --fg: #18181b; --muted: #71717a; --line: #e4e4e7;
    --card: #fafafa; --accent: #3e65c4; --ok: #12805c; --err: #c0392b;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#000; --fg:#ededed; --muted:#9b9b9b; --line:#2a2a2a; --card:#0f0f10; --accent:#7a97e0; --ok:#5fd0a0; --err:#ff7a6e; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px 20px 64px; background: var(--bg); color: var(--fg);
    font: 14px/1.65 -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  }
  main { max-width: 620px; margin: 0 auto; }
  h1 { font-size: 19px; margin: 0 0 4px; }
  .sub { color: var(--muted); margin: 0 0 24px; font-size: 12.5px; }
  .card { border: 1px solid var(--line); border-radius: 12px; padding: 18px 18px 6px; background: var(--card); }
  .field { display: block; margin-bottom: 16px; }
  .field > span { display: block; font-weight: 600; margin-bottom: 6px; }
  input[type=text], input[type=password] {
    width: 100%; padding: 9px 11px; border: 1px solid var(--line); border-radius: 8px;
    background: var(--bg); color: var(--fg); font-size: 13px; outline: none;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  }
  input:focus { border-color: var(--accent); }
  small { display: block; color: var(--muted); margin-top: 6px; font-size: 12px; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; margin: 4px 0 16px; }
  button {
    padding: 8px 16px; border-radius: 8px; border: 1px solid var(--line);
    background: var(--bg); color: var(--fg); font: inherit; cursor: pointer;
  }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
  button:disabled { opacity: .55; cursor: default; }
  #msg { min-height: 22px; font-size: 13px; margin: 0 0 12px; }
  #msg.ok { color: var(--ok); }
  #msg.err { color: var(--err); white-space: pre-wrap; }
  .meta { margin-top: 22px; color: var(--muted); font-size: 12.5px; }
  .meta code { font-size: 12px; word-break: break-all; }
  .pill { display: inline-block; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--line); font-size: 11.5px; }
</style>
</head>
<body>
<main>
  <h1>PageAsk 配置</h1>
  <p class="sub">后端 ${version} 保存后立即生效</p>

  <div class="card">
    <label class="field">
      <span>API Key</span>
      <input id="apiKey" type="password" autocomplete="off" spellcheck="false" placeholder="未设置">
      <small id="keyHint">留空即不修改</small>
    </label>

    <label class="field">
      <span>Base URL (Responses API)</span>
      <input id="baseUrl" type="text" spellcheck="false" placeholder="https://api.deepseek.com">
    </label>

    <label class="field">
      <span>模型</span>
      <input id="model" type="text" spellcheck="false" placeholder="deepseek-flash">
    </label>

    <label class="field">
      <span>Responses API 功能</span>
      <select id="state">
        <option value="auto">自动检测</option>
        <option value="on">有状态</option>
        <option value="off">无状态</option>
      </select>
      <small>是否启用 Responses API 服务端会话状态保持特性</small>
    </label>

    <div class="row">
      <button class="primary" id="save">保存</button>
      <button id="test">测试连接</button>
    </div>
    <p id="msg"></p>
  </div>

  <p class="meta">
    配置文件：<code id="file">…</code><br>
    后端：<code id="hBase">…</code><br>
    模型：<code id="hModel">…</code><br>
    API Key：<code id="hKey">…</code><br>
    Responses API 功能：<code id="hState">…</code>
  </p>
</main>

<script>
const $ = (id) => document.getElementById(id);
const msg = $('msg');

function setMsg(text, kind) {
  msg.textContent = text || '';
  msg.className = kind || '';
}

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) throw new Error((data && (data.error || data.message)) || ('HTTP ' + res.status));
  return data;
}

function fill(view) {
  $('baseUrl').value = view.baseUrl || '';
  $('model').value = view.model || '';
  $('state').value = view.state || 'auto';
  $('file').textContent = view.settingsFile || '';
  $('apiKey').placeholder = view.hasKey ? ('已设置：' + view.apiKeyMasked) : '未设置';
  $('keyHint').textContent = view.hasKey
    ? '留空即不修改'
    : '请填写 API Key';
}

async function load() {
  try {
    fill(await api('/api/settings'));
  } catch (err) {
    setMsg('读不到配置：' + err.message, 'err');
  }
  try {
    const h = await api('/health');
    // 每项独占一行，长 URL 也不再挤成一段
    $('hBase').textContent = h.baseUrl || '';
    $('hModel').textContent = h.model || '';
    $('hKey').textContent = h.hasKey ? '已配置' : '缺失';
    $('hState').textContent = h.statefulActive ? '有状态' : '无状态';
  } catch {
    $('hBase').textContent = '无法连接';
    $('hModel').textContent = '';
    $('hKey').textContent = '';
    $('hState').textContent = '';
  }
}

$('save').onclick = async () => {
  $('save').disabled = true;
  setMsg('保存中…', '');
  try {
    const view = await api('/api/settings', {
      baseUrl: $('baseUrl').value,
      model: $('model').value,
      state: $('state').value,
      apiKey: $('apiKey').value,
    });
    $('apiKey').value = '';
    fill(view);
    setMsg('已保存', 'ok');
  } catch (err) {
    setMsg('保存失败：' + err.message, 'err');
  } finally {
    $('save').disabled = false;
  }
};

$('test').onclick = async () => {
  $('test').disabled = true;
  setMsg('正在请求上游…', '');
  try {
    const r = await api('/api/settings/test', {});
    setMsg(r.ok ? ('连接正常 · ' + r.detail) : ('连不通 · ' + r.detail), r.ok ? 'ok' : 'err');
  } catch (err) {
    setMsg('测试失败：' + err.message, 'err');
  } finally {
    $('test').disabled = false;
  }
};

load();
</script>
</body>
</html>`;
}
