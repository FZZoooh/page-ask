// Run the backend regressions one by one with a per-script deadline.
// A single wedged fetch/child must not consume the whole CI job or hide which script hung.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT_MS = 180_000;

const TESTS = [
  'test-extension-id.mjs',
  'test-upstream-url.mjs',
  'test-turn-integrity.mjs',
  'test-reasoning-replay.mjs',
  'test-turn-abort.mjs',
  'test-empty-stream.mjs',
  'test-incomplete-and-bad-body.mjs',
  'test-lifecycle-recover.mjs',
  'test-settings-webui.mjs',
  'test-ssrf.mjs',
  'test-pdf-auth.mjs',
  'test-partial-failure.mjs',
  'test-auto-title.mjs',
  'test-truncated-stream.mjs',
  'test-chat-busy.mjs',
  'test-stateful-fallback.mjs',
  'test-host.mjs',
  'test-tool-cap.mjs',
  'test-page-metadata.mjs',
  'test-i18n-chat.mjs',
  'test-sse-crlf.mjs',
  'test-pdf-limits.mjs',
  'test-history-page.mjs',
  'test-hist-time.mjs',
  'test-markdown-stream.mjs',
  'test-edge-profile.mjs',
  'test-pdf-cancel.mjs',
  'test-upstream-error-cap.mjs',
  'test-i18n-guard.mjs',
  'test-migration.mjs',
  'test-cors-origin.mjs',
];

function runOne(script) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, 'scripts', script)], {
      cwd: ROOT,
      env: process.env,
      stdio: 'inherit',
      windowsHide: true,
    });
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      console.error(`\n[timeout] ${script} exceeded ${TIMEOUT_MS / 1000}s`);
      if (process.platform === 'win32') {
        // Kill the whole tree: the test may have spawned a backend that keeps stdio open.
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        killer.on('close', () => finish(1));
        killer.on('error', () => {
          child.kill();
          finish(1);
        });
      } else {
        child.kill('SIGKILL');
        finish(1);
      }
    }, TIMEOUT_MS);

    child.on('error', (err) => {
      console.error(`\n[failed] ${script}: ${err.message}`);
      finish(1);
    });
    child.on('close', (code) => finish(code ?? 1));
  });
}

for (let i = 0; i < TESTS.length; i++) {
  const script = TESTS[i];
  console.log(`\n[${i + 1}/${TESTS.length}] ${script}`);
  const code = await runOne(script);
  if (code !== 0) {
    console.error(`\n[failed] ${script} exited with ${code}`);
    process.exit(code || 1);
  }
}
console.log(`\nAll ${TESTS.length} backend test scripts passed.`);
