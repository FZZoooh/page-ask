// Regression: -ProfileName is user input and used to be passed to Remove-Item. The test only
// exercises -ValidateOnly, so it never builds, launches Edge, or deletes a profile.
// Run: node scripts/test-edge-profile.mjs
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(root, 'scripts', 'edge-test.ps1');

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !extra ? '' : ` — ${extra}`}`);
  if (!ok) failures += 1;
};

if (process.platform !== 'win32') {
  console.log('skip: edge-test.ps1 is Windows-only');
  process.exit(0);
}

const run = (profile) =>
  spawnSync('pwsh', ['-NoProfile', '-File', script, '-ProfileName', profile, '-ValidateOnly'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  });

const bad = run('..');
check('rejects parent-directory profile', bad.status !== 0, `${bad.status} ${bad.stderr}`);
check('rejection has no stack-trace success', !/profile=.*\.\./.test(bad.stdout), bad.stdout.trim());

const good = run('ci');
check('accepts a normal profile', good.status === 0, `${good.status} ${good.stderr}`);
check(
  'profile stays under .edge-profiles',
  /profile=.*[\\/]\.edge-profiles[\\/]ci\s*$/i.test(good.stdout.trim()),
  good.stdout.trim(),
);

const fallback = spawnSync('pwsh', ['-NoProfile', '-File', script, '-ValidateOnly'], {
  encoding: 'utf8',
  windowsHide: true,
  timeout: 30_000,
});
check('accepts the default profile', fallback.status === 0, `${fallback.status} ${fallback.stderr}`);
check(
  'default profile is a valid one-segment name',
  /profile=.*[\\/]\.edge-profiles[\\/]edge-profile9358\s*$/i.test(fallback.stdout.trim()),
  fallback.stdout.trim(),
);

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exitCode = failures ? 1 : 0;
