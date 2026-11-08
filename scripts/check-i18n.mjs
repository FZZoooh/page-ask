/**
 * P4 localization guard:
 *   1. UI code must not add hard-coded Chinese (string literals only; comments and `[pageask]` logs are exempt).
 *   2. Error-code coverage: every `error.*` key in the server dictionary needs matching extension copy;
 *      code literals appearing in server sources must exist in the dictionary.
 *   3. Locale keys stay aligned; `en-XA` pseudo-localization must exist and be clearly longer (layout tests).
 *   4. Every `$script:Tray.*` key referenced by the tray scripts must exist in Tray.psd1.
 *
 * Usage: `node scripts/check-i18n.mjs` (called by `pnpm verify`).
 */
import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const problems = [];
function fail(file, line, message) {
  problems.push(`${file}:${line}  ${message}`);
}

/** Strip JS/TS comments and collect string literals (template strings included). */
function collectJsStrings(text) {
  const out = [];
  let i = 0;
  let line = 1;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n') line++;
        i++;
      }
      i += 2;
      continue;
    }
    if (ch === '\n') {
      line++;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      const startLine = line;
      let j = i + 1;
      let value = '';
      while (j < text.length) {
        const cur = text[j];
        if (cur === '\\') {
          value += text[j] + (text[j + 1] ?? '');
          if (text[j + 1] === '\n') line++;
          j += 2;
          continue;
        }
        if (cur === quote) {
          j++;
          break;
        }
        if (cur === '\n') line++;
        value += cur;
        j++;
      }
      out.push({ value, line: startLine });
      i = j;
      continue;
    }
    i++;
  }
  return out;
}

/** PowerShell: strip `<# #>` and `#` comments, collect single/double-quoted strings. */
function collectPsStrings(text) {
  const out = [];
  let i = 0;
  let line = 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '<' && text[i + 1] === '#') {
      i += 2;
      while (i < text.length && !(text[i] === '#' && text[i + 1] === '>')) {
        if (text[i] === '\n') line++;
        i++;
      }
      i += 2;
      continue;
    }
    if (ch === '#') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '\n') {
      line++;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      const startLine = line;
      let j = i + 1;
      let value = '';
      while (j < text.length) {
        const cur = text[j];
        if (cur === quote) {
          if (text[j + 1] === quote) {
            value += quote;
            j += 2;
            continue;
          }
          j++;
          break;
        }
        if (cur === '`') {
          value += text[j + 1] ?? '';
          j += 2;
          continue;
        }
        if (cur === '\n') line++;
        value += cur;
        j++;
      }
      out.push({ value, line: startLine });
      i = j;
      continue;
    }
    i++;
  }
  return out;
}

const CJK = /[\u4e00-\u9fff]/;

function checkHardcodedChinese() {
  // Both dictionaries are the copy itself: zh-CN is all Chinese and en-US keeps the
  // native-script language label on purpose, so neither counts as hard-coded UI text.
  const dicts = new Set(['src/lib/i18n.ts', 'src/lib/i18n.en-US.ts']);
  const jsFiles = globSync('src/**/*.{ts,tsx}').filter((f) => !dicts.has(f.replaceAll('\\', '/')));
  const psFiles = ['scripts/tray.ps1', 'scripts/tray-bg.ps1'];
  // The backend is user-facing too: tool labels, settings-test details and PDF errors all reach the
  // panel or the settings page. Server dictionaries are the copy itself, so they are the only exemption.
  const serverFiles = globSync('server/**/*.mjs').filter((f) => !f.replaceAll('\\', '/').includes('server/i18n/'));
  const configFiles = ['wxt.config.ts'];

  for (const file of [...jsFiles, ...serverFiles, ...configFiles]) {
    const text = readFileSync(file, 'utf8');
    for (const s of collectJsStrings(text)) {
      if (!CJK.test(s.value)) continue;
      // Dev logs all start with [pageask]; they are not user-facing UI copy
      if (s.value.trimStart().startsWith('[pageask]')) continue;
      fail(file, s.line, `硬编码中文：${JSON.stringify(s.value.slice(0, 80))}`);
    }
  }
  for (const file of psFiles) {
    const text = readFileSync(file, 'utf8');
    for (const s of collectPsStrings(text)) {
      if (!CJK.test(s.value)) continue;
      fail(file, s.line, `硬编码中文：${JSON.stringify(s.value.slice(0, 80))}`);
    }
  }
}

async function loadDict(file) {
  const mod = await import(pathToFileURL(resolve(file)).href);
  return mod;
}

async function checkErrorCodes() {
  const server = await loadDict('server/i18n/zh-CN.mjs');
  const serverCodes = new Set(
    Object.keys(server.default)
      .filter((key) => key.startsWith('error.'))
      .map((key) => key.slice('error.'.length)),
  );

  const clientSrc = readFileSync('src/lib/i18n.ts', 'utf8');
  const clientCodes = new Set(
    collectJsStrings(clientSrc)
      .map((s) => s.value)
      .filter((value) => value.startsWith('error.') && !value.includes('${') && value !== 'error.')
      .map((value) => value.slice('error.'.length)),
  );

  // Errors only the extension raises (network/load/clipboard); the backend never sends these codes
  const clientOnly = new Set([
    'backendDetail',
    'backendStatus',
    'historyDelete',
    'historyLoad',
    'pageMismatch',
    'streamCut',
    'unknown',
    'unreachable',
  ]);

  for (const code of serverCodes) {
    if (!clientCodes.has(code)) fail('src/lib/i18n.ts', 0, `缺少 error.${code} 文案`);
  }
  for (const code of clientCodes) {
    if (!serverCodes.has(code) && !clientOnly.has(code)) {
      fail('src/lib/i18n.ts', 0, `error.${code} 不是已知的后端 code，也不在 clientOnly 白名单`);
    }
  }

  // Codes spelled out in server sources must exist in the dictionary. Scan only the `errorPayload`
  // and `new UpstreamError` code args, so event names like `settings.saved` are not read as error codes.
  for (const file of globSync('server/**/*.mjs').filter((f) => !f.includes('/i18n/'))) {
    const text = readFileSync(file, 'utf8');
    const codes = [
      ...[...text.matchAll(/errorPayload\(\s*'([^']+)'/g)].map((m) => m[1]),
      ...[
        ...text.matchAll(
          /new UpstreamError\([\s\S]{0,240}?'((?:auth|request|conversation|settings|chat|upstream|pdf)\.[a-z][\w.]*)'/g,
        ),
      ].map((m) => m[1]),
    ];
    for (const code of codes) {
      if (!serverCodes.has(code)) {
        fail(file, 0, `错误码 ${code} 没有 error.${code} 文案`);
      }
    }
  }
}

async function checkLocales() {
  const zh = await loadDict('server/i18n/zh-CN.mjs');
  const en = await loadDict('server/i18n/en-US.mjs');
  const xa = await loadDict('server/i18n/en-XA.mjs');
  const zhKeys = Object.keys(zh.default).sort();

  for (const [file, dict] of [
    ['server/i18n/en-US.mjs', en],
    ['server/i18n/en-XA.mjs', xa],
  ]) {
    const keys = Object.keys(dict.default).sort();
    if (zhKeys.join('\n') !== keys.join('\n')) {
      fail(file, 0, `key 与 zh-CN 不一致（缺 ${zhKeys.filter((k) => !keys.includes(k)).join(', ') || '无'}；多 ${keys.filter((k) => !zhKeys.includes(k)).join(', ') || '无'}）`);
    }
  }

  let zhLen = 0;
  let xaLen = 0;
  for (const key of zhKeys) {
    const base = zh.default[key];
    const pseudo = xa.default[key];
    if (typeof base !== 'string') continue;
    if (typeof pseudo !== 'string' || !pseudo.startsWith('[!!')) {
      fail('server/i18n/en-XA.mjs', 0, `${key} 不是伪本地化文案`);
    }
    zhLen += base.length;
    xaLen += String(pseudo).length;
  }
  if (xaLen <= zhLen) {
    fail('server/i18n/en-XA.mjs', 0, '伪本地化没有变长，测不出布局问题');
  }

  const index = await loadDict('server/i18n/index.mjs');
  for (const locale of ['en-US', 'en-XA']) {
    if (!index.SUPPORTED_LOCALES.includes(locale)) {
      fail('server/i18n/index.mjs', 0, `${locale} 没有注册进 DICTS`);
    }
  }
}

async function checkTrayKeys() {
  const texts = ['scripts/tray.ps1', 'scripts/tray-bg.ps1'].map((f) => readFileSync(f, 'utf8'));
  const dictFiles = ['scripts/i18n/zh-CN/Tray.psd1', 'scripts/i18n/en-US/Tray.psd1'];
  const keySets = dictFiles.map((file) => {
    const dictText = readFileSync(file, 'utf8');
    return new Set(
      [...dictText.matchAll(/^\s*([A-Za-z]\w*)\s*=\s*'/gm)].map((m) => m[1]),
    );
  });
  const used = new Set(
    texts.flatMap((text) =>
      [...text.matchAll(/\$(?:script:)?Tray\.(\w+)/g)].map((m) => m[1]),
    ),
  );

  for (const [i, file] of dictFiles.entries()) {
    const keys = keySets[i];
    for (const key of used) {
      if (!keys.has(key)) fail(file, 0, `缺少 ${key}`);
    }
    for (const key of keys) {
      if (!used.has(key)) fail(file, 0, `${key} 未被使用`);
    }
  }

  const [zhKeys, enKeys] = keySets;
  for (const key of zhKeys) {
    if (!enKeys.has(key)) fail('scripts/i18n/en-US/Tray.psd1', 0, `缺少 ${key}`);
  }
  for (const key of enKeys) {
    if (!zhKeys.has(key)) fail('scripts/i18n/zh-CN/Tray.psd1', 0, `缺少 ${key}`);
  }
}

checkHardcodedChinese();
await checkErrorCodes();
await checkLocales();
await checkTrayKeys();

if (problems.length > 0) {
  console.error(`✗ i18n 检查失败（${problems.length} 项）：`);
  for (const p of problems) console.error(`  ${p}`);
  process.exitCode = 1;
} else {
  console.log('✓ i18n 检查通过（硬编码中文、错误码、locale、托盘 key）');
}
