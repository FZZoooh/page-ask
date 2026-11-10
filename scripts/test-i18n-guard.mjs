// Regression: check-i18n must see JSX text, not only quoted strings, and must work from any cwd.
// Run: node scripts/test-i18n-guard.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findHardcodedChinese } from './check-i18n.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${name}\n     ${err.message}`);
  }
}

check('JSX text is detected', () => {
  const found = findHardcodedChinese('x.tsx', 'const x = <div>确定</div>;');
  assert.equal(found.length, 1);
  assert.match(found[0].value, /确定/);
});

check('English JSX text is allowed', () => {
  assert.deepEqual(findHardcodedChinese('x.tsx', 'const x = <div>OK</div>;'), []);
});

check('comments and string literals are not double-reported', () => {
  const found = findHardcodedChinese(
    'x.tsx',
    '// 中文\nconst x = <div>OK</div>; const y = "中文";',
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].value, '中文');
});

check('URL strings do not hide JSX copy on the same line', () => {
  const found = findHardcodedChinese(
    'x.tsx',
    'const u = "https://example.com"; const x = <a href="https://example.com">中文</a>;',
  );
  assert.ok(found.some((s) => s.value.includes('中文')), JSON.stringify(found));
});

check('a plain URL in JSX copy does not hide the copy', () => {
  const found = findHardcodedChinese('x.tsx', 'const x = <p>see https://example.com 说明</p>;');
  assert.ok(found.some((s) => s.value.includes('说明')), JSON.stringify(found));
});

check('apostrophes in JSX copy do not hide the copy', () => {
  const found = findHardcodedChinese('x.tsx', "const x = <div>Don't 删除</div>;");
  assert.ok(found.some((s) => s.value.includes('删除')), JSON.stringify(found));
});

check('the guard still passes from a subdirectory', () => {
  const res = spawnSync(process.execPath, [join(root, 'scripts', 'check-i18n.mjs')], {
    cwd: join(root, 'docs'),
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /i18n 检查通过/);
});

console.log(failed ? `\n${failed} failure(s)` : '\nall good');
process.exitCode = failed ? 1 : 0;
