// Regression: -ProfileName is user input and used to be passed to Remove-Item. The test only
// exercises -ValidateOnly, so it never builds, launches Edge, or deletes a profile.
// Run: node scripts/test-edge-profile.mjs
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(root, 'scripts', 'edge-test.ps1');

if (process.platform !== 'win32') {
  console.log('skip: edge-test.ps1 is Windows-only');
  process.exit(0);
}

// GitHub's windows-latest image exposes pwsh through the shell, but a child process does not
// always inherit that PATH shim. Fall back to Windows PowerShell: -ValidateOnly only needs
// parameter binding and file-path APIs that 5.1 supports.
function findPowerShell() {
  for (const exe of ['pwsh', 'powershell']) {
    const probe = spawnSync(exe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'exit 0'], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    });
    if (!probe.error && probe.status === 0) return exe;
  }
  return null;
}

const shell = findPowerShell();
if (!shell) {
  console.error('FAIL: neither pwsh nor powershell is available');
  process.exit(1);
}

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !extra ? '' : ` — ${extra}`}`);
  if (!ok) failures += 1;
};

const run = (profile) =>
  spawnSync(
    shell,
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      ...(profile ? ['-ProfileName', profile] : []),
      '-ValidateOnly',
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
    },
  );

const bad = run('..');
check(
  'rejects parent-directory profile',
  bad.status !== 0 && !bad.error,
  `${bad.status} ${bad.error?.message ?? ''} ${bad.stderr ?? ''}`,
);
const badOut = bad.stdout ?? '';
check('rejection has no profile path', !/profile=.*\.\./.test(badOut), badOut.trim());

const good = run('ci');
check('accepts a normal profile', good.status === 0, `${good.status} ${good.error?.message ?? ''} ${good.stderr ?? ''}`);
check(
  'profile stays under .edge-profiles',
  /profile=.*[\\/]\.edge-profiles[\\/]ci\s*$/i.test(good.stdout?.trim() ?? ''),
  good.stdout?.trim() ?? '',
);

const fallback = run('');
check('accepts the default profile', fallback.status === 0, `${fallback.status} ${fallback.error?.message ?? ''} ${fallback.stderr ?? ''}`);
check(
  'default profile is a valid one-segment name',
  /profile=.*[\\/]\.edge-profiles[\\/]edge-profile9358\s*$/i.test(fallback.stdout?.trim() ?? ''),
  fallback.stdout?.trim() ?? '',
);

console.log(failures ? `\n${failures} failure(s)` : '\nall good');
process.exitCode = failures ? 1 : 0;
