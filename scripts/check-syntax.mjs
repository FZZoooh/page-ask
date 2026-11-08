// `pnpm compile` only runs tsc, which never sees .mjs; run a real syntax check on backend + scripts here.
// Usage: node scripts/check-syntax.mjs
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dirs = ['server', 'scripts'];
const files = [];

// Recursive: .mjs files in subdirectories such as server/i18n/ must be checked too.
function collect(dir) {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) collect(rel);
    else if (entry.name.endsWith('.mjs')) files.push(join(root, rel));
  }
}

for (const dir of dirs) collect(dir);

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
