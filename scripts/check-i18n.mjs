/**
 * P4 本地化守护：
 *   1. UI 层禁止新增硬编码中文（只看字符串字面量，忽略注释与 `[pageask]` 日志）。
 *   2. 错误码覆盖：server 字典里的 `error.*` 都要在扩展字典里有对应文案；
 *      server 源码里出现的 code 字面量必须在字典中存在。
 *   3. locale 字典 key 对齐；`en-XA` 伪本地化必须存在且明显更长（测布局用）。
 *   4. 托盘脚本引用的 `$script:Tray.*` key 必须在 Tray.psd1 中存在。
 *
 * 用法：`node scripts/check-i18n.mjs`（由 `pnpm verify` 调用）。
 */
import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const problems = [];
function fail(file, line, message) {
  problems.push(`${file}:${line}  ${message}`);
}

/** 去掉 JS/TS 注释并收集字符串字面量（含模板串）。 */
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

/** PowerShell：去掉 `<# #>` 与 `#` 注释，收集单/双引号字符串。 */
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
  const jsFiles = globSync('src/**/*.{ts,tsx}').filter(
    (f) => f.replaceAll('\\', '/') !== 'src/lib/i18n.ts',
  );
  const psFiles = ['scripts/tray.ps1', 'scripts/tray-bg.ps1'];
  const wsFiles = ['server/webui.mjs'];

  for (const file of [...jsFiles, ...wsFiles]) {
    const text = readFileSync(file, 'utf8');
    for (const s of collectJsStrings(text)) {
      if (!CJK.test(s.value)) continue;
      // 开发日志统一以 [pageask] 开头，不属于用户界面文案
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

  // 扩展侧独有的错误（网络/加载/剪贴板），后端不会发这些 code
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

  // server 源码里显式写出的 code 必须在字典里。只看 errorPayload 与
  // new UpstreamError 的 code 参数，避免把 `settings.saved` 这类事件名当成错误码。
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
  const xa = await loadDict('server/i18n/en-XA.mjs');
  const zhKeys = Object.keys(zh.default).sort();
  const xaKeys = Object.keys(xa.default).sort();

  if (zhKeys.join('\n') !== xaKeys.join('\n')) {
    fail('server/i18n/en-XA.mjs', 0, 'en-XA 与 zh-CN 的 key 不一致');
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
  if (!index.SUPPORTED_LOCALES.includes('en-XA')) {
    fail('server/i18n/index.mjs', 0, 'en-XA 没有注册进 DICTS');
  }
}

async function checkTrayKeys() {
  const texts = ['scripts/tray.ps1', 'scripts/tray-bg.ps1'].map((f) => readFileSync(f, 'utf8'));
  const dictText = readFileSync('scripts/i18n/zh-CN/Tray.psd1', 'utf8');
  const keys = new Set(
    [...dictText.matchAll(/^\s*([A-Za-z]\w*)\s*=\s*'/gm)].map((m) => m[1]),
  );
  const used = new Set(
    texts.flatMap((text) =>
      [...text.matchAll(/\$(?:script:)?Tray\.(\w+)/g)].map((m) => m[1]),
    ),
  );
  for (const key of used) {
    if (!keys.has(key)) fail('scripts/i18n/zh-CN/Tray.psd1', 0, `缺少 ${key}`);
  }
  for (const key of keys) {
    if (!used.has(key)) fail('scripts/i18n/zh-CN/Tray.psd1', 0, `${key} 未被使用`);
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
