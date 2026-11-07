/**
 * 配置页 HTML（`GET /settings`）。刻意不用任何构建步骤：一个字符串、内联样式和内联脚本，
 * 打开就能改 Key / 上游地址 / 模型，保存后下一个请求立刻生效（后端每次都重读 settings.json）。
 *
 * 所有文案来自 `server/i18n/zh-CN.mjs`：页面渲染时按 `Accept-Language` / `?lang=` 选字典，
 * 再把整份字典嵌给客户端脚本，避免中文散落在 HTML 与 JS 里。加语言只需加字典。
 */
import { DEFAULT_LOCALE, dictionary, format } from './i18n/index.mjs';

export function settingsPageHtml({ version, locale = DEFAULT_LOCALE }) {
  const dict = dictionary(locale);
  const t = (key, vars) => format(dict[key] ?? key, vars);
  // `</script>` 不能出现在内联脚本里；字典本身没有 HTML，这里仍把 `<` 转义掉
  const clientDict = JSON.stringify(dict).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t('webui.title')}</title>
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
  input[type=text], input[type=password], select {
    width: 100%; padding: 9px 11px; border: 1px solid var(--line); border-radius: 8px;
    background: var(--bg); color: var(--fg); font-size: 13px; outline: none;
  }
  input[type=text], input[type=password] {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  }
  input:focus, select:focus { border-color: var(--accent); }
  input:focus-visible, select:focus-visible, button:focus-visible {
    outline: 2px solid var(--accent); outline-offset: 2px;
  }
  small { display: block; color: var(--muted); margin-top: 6px; font-size: 12px; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin: 4px 0 16px; }
  button {
    padding: 8px 16px; border-radius: 8px; border: 1px solid var(--line);
    background: var(--bg); color: var(--fg); font: inherit; cursor: pointer;
  }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
  button.danger { color: var(--err); border-color: color-mix(in srgb, var(--err) 45%, var(--line)); }
  button:disabled { opacity: .55; cursor: default; }
  #msg { min-height: 22px; font-size: 13px; margin: 0 0 12px; }
  #msg.ok { color: var(--ok); }
  #msg.err { color: var(--err); white-space: pre-wrap; }
  .meta { margin-top: 22px; color: var(--muted); font-size: 12.5px; }
  .meta code { font-size: 12px; word-break: break-all; }
  .note { color: var(--muted); font-size: 12px; margin: 12px 0 0; }
</style>
</head>
<body>
<main>
  <h1>${t('webui.title')}</h1>
  <p class="sub">${t('webui.subtitle', { version })}</p>

  <div class="card">
    <label class="field">
      <span>${t('webui.apiKey')}</span>
      <input id="apiKey" type="password" autocomplete="off" spellcheck="false" placeholder="${t('webui.apiKeyPlaceholderMissing')}">
      <small id="keyHint">${t('webui.keyHintKeep')}</small>
    </label>

    <label class="field">
      <span>${t('webui.baseUrl')}</span>
      <input id="baseUrl" type="text" spellcheck="false" placeholder="https://api.deepseek.com">
    </label>

    <label class="field">
      <span>${t('webui.model')}</span>
      <input id="model" type="text" spellcheck="false" placeholder="deepseek-flash">
    </label>

    <label class="field">
      <span>${t('webui.state')}</span>
      <select id="state">
        <option value="auto">${t('webui.stateAuto')}</option>
        <option value="on">${t('webui.stateOn')}</option>
        <option value="off">${t('webui.stateOff')}</option>
      </select>
      <small>${t('webui.stateHint')}</small>
    </label>

    <div class="row">
      <button class="primary" id="save" type="button">${t('webui.save')}</button>
      <button id="test" type="button">${t('webui.test')}</button>
      <button class="danger" id="clearKey" type="button" hidden>${t('webui.clearKey')}</button>
    </div>
    <p id="msg" role="status" aria-live="polite" aria-atomic="true"></p>
  </div>

  <p class="meta">
    ${t('webui.metaFile')}<code id="file">…</code><br>
    ${t('webui.metaProvider')}<code id="hBase">…</code><br>
    ${t('webui.metaModel')}<code id="hModel">…</code><br>
    ${t('webui.metaKey')}<code id="hKey">…</code><br>
    ${t('webui.metaState')}<code id="hState">…</code>
  </p>
</main>

<script>
const M = ${clientDict};
const $ = (id) => document.getElementById(id);
const msg = $('msg');

function m(key, vars) {
  const text = M[key] || key;
  if (!vars) return text;
  return text.replace(/\\{(\\w+)\\}/g, (whole, name) =>
    vars[name] === undefined || vars[name] === null ? whole : String(vars[name]));
}

function setMsg(text, kind) {
  msg.textContent = text || '';
  msg.className = kind || '';
}

function errorText(data, status) {
  if (data && data.code) {
    const key = 'error.' + data.code;
    if (M[key]) return m(key, data.params || {});
  }
  return (data && (data.message || data.error)) || ('HTTP ' + status);
}

async function api(path, body) {
  let res;
  try {
    res = await fetch(path, body === undefined ? {} : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw new Error(m('webui.networkFailed', { message: cause && cause.message ? cause.message : String(cause) }));
  }
  const raw = await res.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
  if (!res.ok) {
    const err = new Error(errorText(data, res.status));
    err.status = res.status;
    err.code = data && data.code;
    throw err;
  }
  return data;
}

function fill(view) {
  $('baseUrl').value = view.baseUrl || '';
  $('model').value = view.model || '';
  $('state').value = view.state || 'auto';
  $('file').textContent = view.settingsFile || '';
  $('apiKey').placeholder = view.hasKey
    ? m('webui.apiKeyPlaceholderSet', { masked: view.apiKeyMasked })
    : m('webui.apiKeyPlaceholderMissing');
  $('keyHint').textContent = view.hasKey ? m('webui.keyHintKeep') : m('webui.keyHintNeed');
  $('clearKey').hidden = !view.hasKey;
  $('hKey').textContent = view.hasKey ? m('webui.keyConfigured') : m('webui.keyMissing');
}

async function load() {
  try {
    fill(await api('/api/settings'));
  } catch (err) {
    setMsg(m('webui.readFailed', { message: err.message }), 'err');
  }
  try {
    const h = await api('/health');
    // 每项独占一行，长 URL 也不再挤成一段
    $('hBase').textContent = h.baseUrl || '';
    $('hModel').textContent = h.model || '';
    $('hKey').textContent = h.hasKey ? m('webui.keyConfigured') : m('webui.keyMissing');
    $('hState').textContent = h.statefulActive ? m('webui.stateful') : m('webui.stateless');
  } catch (err) {
    const text = err.status === 401
      ? m('webui.healthTokenRequired')
      : m('webui.healthUnavailable');
    $('hBase').textContent = text;
    $('hModel').textContent = '';
    $('hState').textContent = '';
  }
}

$('save').onclick = async () => {
  $('save').disabled = true;
  setMsg(m('webui.saving'), '');
  try {
    const view = await api('/api/settings', {
      baseUrl: $('baseUrl').value,
      model: $('model').value,
      state: $('state').value,
      apiKey: $('apiKey').value,
    });
    $('apiKey').value = '';
    fill(view);
    setMsg(m('webui.saved'), 'ok');
  } catch (err) {
    setMsg(m('webui.saveFailed', { message: err.message }), 'err');
  } finally {
    $('save').disabled = false;
  }
};

$('test').onclick = async () => {
  $('test').disabled = true;
  setMsg(m('webui.testing'), '');
  try {
    const r = await api('/api/settings/test', {
      baseUrl: $('baseUrl').value,
      model: $('model').value,
      apiKey: $('apiKey').value,
    });
    if (r.ok) {
      setMsg(m('webui.testOk', { detail: r.detail }), 'ok');
    } else {
      const detail = r.code && M['error.' + r.code] ? m('error.' + r.code, r.params || {}) : r.detail;
      setMsg(m('webui.testFail', { detail }), 'err');
    }
  } catch (err) {
    setMsg(m('webui.testError', { message: err.message }), 'err');
  } finally {
    $('test').disabled = false;
  }
};

$('clearKey').onclick = async () => {
  if (!confirm(m('webui.clearConfirm'))) return;
  $('clearKey').disabled = true;
  try {
    const view = await api('/api/settings', { clearApiKey: true });
    $('apiKey').value = '';
    fill(view);
    setMsg(m('webui.cleared'), 'ok');
  } catch (err) {
    setMsg(m('webui.clearFailed', { message: err.message }), 'err');
  } finally {
    $('clearKey').disabled = false;
  }
};

load();
</script>
</body>
</html>`;
}
