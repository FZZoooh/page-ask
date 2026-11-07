// `pnpm compile` 只跑 tsc，覆盖不到 .mjs；这里对后端与脚本做一次真实的语法检查。
// 用法：node scripts/check-syntax.mjs
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dirs = ['server', 'scripts'];
const files = [];
for (const dir of dirs) {
  for (const name of readdirSync(join(root, dir))) {
    if (name.endsWith('.mjs')) files.push(join(root, dir, name));
  }
}

let failed = 0;
for (const file of files) {
  const r = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (r.status !== 0) {
    failed += 1;
    console.error(`✗ ${file}`);
  }
}

if (failed) {
  console.error(`\n${failed}/${files.length} 个文件语法错误`);
  process.exitCode = 1;
} else {
  console.log(`✓ ${files.length} 个 .mjs 语法检查通过`);
}
