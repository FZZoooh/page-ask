// `pnpm compile` runs tsc, which never sees .mjs or .ps1; check both here.
// Usage: node scripts/check-syntax.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dirs = ['server', 'scripts', 'src/lib'];
const mjsFiles = [];
const psFiles = [];

// Recursive: .mjs files in subdirectories such as server/i18n/ must be checked too.
function collect(dir) {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) collect(rel);
    else if (entry.name.endsWith('.mjs')) mjsFiles.push(join(root, rel));
    else if (entry.name.endsWith('.ps1') || entry.name.endsWith('.psd1')) psFiles.push(join(root, rel));
  }
}

for (const dir of dirs) collect(dir);

let failed = 0;
for (const file of mjsFiles) {
  const r = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (r.status !== 0) {
    failed += 1;
    console.error(`✗ ${file}`);
  }
}

// Windows PowerShell 5.1 reads a BOM-less UTF-8 psd1/ps1 as ANSI, so localized text turns into mojibake.
// Every PowerShell file in this repo is UTF-8 with BOM; enforce it instead of relying on review.
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
for (const file of psFiles) {
  const head = readFileSync(file).subarray(0, 3);
  if (!head.equals(BOM)) {
    failed += 1;
    console.error(`✗ ${file}: missing UTF-8 BOM`);
  }
}

if (psFiles.length > 0 && process.platform === 'win32') {
  // ParseFile uses the same grammar as the runtime; it catches missing braces/params without executing anything.
  const list = psFiles.map((file) => `'${file.replace(/'/g, "''")}'`).join(',');
  const command =
    `$files=@(${list}); $bad=0; ` +
    'foreach ($f in $files) { $tokens=$null; $errors=$null; ' +
    '[System.Management.Automation.Language.Parser]::ParseFile($f,[ref]$tokens,[ref]$errors) | Out-Null; ' +
    'if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Host ("{0}:{1}: {2}" -f $f, $_.Extent.StartLineNumber, $_.Message) }; $bad++ } }; ' +
    'exit $bad';
  const args = ['-NoProfile', '-NonInteractive', '-Command', command];
  let r = spawnSync('pwsh', args, { stdio: 'inherit' });
  if (r.error?.code === 'ENOENT') r = spawnSync('powershell', args, { stdio: 'inherit' });
  if (r.error) {
    failed += 1;
    console.error(`✗ PowerShell parser unavailable: ${r.error.message}`);
  } else if (r.status !== 0) {
    failed += 1;
    console.error('✗ PowerShell syntax check failed');
  }
}

if (failed) {
  console.error(`\n${failed} syntax/encoding error(s) (${mjsFiles.length} .mjs, ${psFiles.length} PowerShell files)`);
  process.exitCode = 1;
} else {
  console.log(`✓ ${mjsFiles.length} .mjs and ${psFiles.length} PowerShell files passed syntax checks`);
}
