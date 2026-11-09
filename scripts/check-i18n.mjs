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
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CJK = /[\u4e00-\u9fff]/;

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

/** Blank out JS/TS comments while preserving newlines and character positions. */
function stripJsComments(text) {
  const out = [];
  let i = 0;
  // A quote is a string delimiter only in expression position. JSX text may contain
  // apostrophes ("Don't"), and treating one as a string start would hide the rest of
  // the line, including its Chinese copy.
  const isStringStart = () => {
    let j = out.length - 1;
    while (j >= 0 && /\s/.test(out[j])) j--;
    if (j < 0) return true;
    return '=(:[,;!&|?+-*%<>{}~^'.includes(out[j]);
  };
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '/' && next === '/') {
      // `https://` in JSX copy is text, not a comment; blanking it would hide the rest
      // of the line, including any Chinese that follows the URL.
      const before = out.join('').slice(-12);
      if (/[a-z][a-z0-9+.-]*:$/i.test(before)) {
        out.push(ch, next);
        i += 2;
        continue;
      }
      while (i < text.length && text[i] !== '\n') {
        out.push(' ');
        i++;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      out.push('  ');
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        out.push(text[i] === '\n' ? '\n' : ' ');
        i++;
      }
      if (i < text.length) {
        out.push('  ');
        i += 2;
      }
      continue;
    }
    if ((ch === "'" || ch === '"' || ch === '`') && isStringStart()) {
      const quote = ch;
      out.push(' ');
      i++;
      while (i < text.length) {
        const cur = text[i];
        if (cur === '\\') {
          out.push(text[i + 1] === '\n' ? '\n' : ' ', text[i + 1] === '\n' ? '' : ' ');
          i += 2;
          continue;
        }
        if (cur === quote) {
          out.push(' ');
          i++;
          break;
        }
        out.push(cur === '\n' ? '\n' : ' ');
        i++;
      }
      continue;
    }
    out.push(ch);
    i++;
  }
  return out.join('');
}

/**
 * Collect Chinese text between a JSX closing `>` and the next `<`.
 *
 * This deliberately avoids the TypeScript compiler API: the installed TS 7 native preview
 * does not expose `createSourceFile`. A tag-to-tag scan is enough here because raw JSX text
 * cannot contain an unescaped `<` or `>`, and a regex also survives apostrophes in copy
 * such as "Don't". Quoted strings are collected separately by collectJsStrings().
 */
function scanJsxText(file, text) {
  const stripped = stripJsComments(text);
  const found = [];
  let line = 1;
  let scanned = 0;
  for (const match of stripped.matchAll(/>([^<>]*)</g)) {
    const index = match.index ?? 0;
    for (let i = scanned; i < index; i++) if (stripped[i] === '\n') line++;
    scanned = index;
    const value = match[1].replace(/\s+/g, ' ').trim();
    if (CJK.test(value)) found.push({ value, line });
  }
  return found;
}

/**
 * All hard-coded Chinese in one source file: quoted literals plus JSX text nodes.
 * Exported so the guard itself can be regression-tested without touching the tree.
 */
export function findHardcodedChinese(file, text) {
  const found = [];
  for (const s of collectJsStrings(text)) {
    if (!CJK.test(s.value)) continue;
    // Dev logs all start with [pageask]; they are not user-facing UI copy
    if (s.value.trimStart().startsWith('[pageask]')) continue;
    found.push({ value: s.value, line: s.line });
  }
  if (file.endsWith('.tsx')) found.push(...scanJsxText(file, text));
  return found;
}

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

  // A cwd/glob mistake must fail loudly instead of reporting a clean scan of zero files.
  if (jsFiles.length === 0 || serverFiles.length === 0) {
    fail('scripts/check-i18n.mjs', 0, `扫描范围为空（js=${jsFiles.length}, server=${serverFiles.length}）`);
    return;
  }

  for (const file of [...jsFiles, ...serverFiles, ...configFiles]) {
    const text = readFileSync(file, 'utf8');
    for (const s of findHardcodedChinese(file, text)) {
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
    'historyUnavailable',
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

async function main() {
  // Globs and dictionary paths below are repo-relative. Anchor them to this file so
  // `node ../scripts/check-i18n.mjs` from a subdirectory cannot scan an empty tree.
  process.chdir(ROOT);

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
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
