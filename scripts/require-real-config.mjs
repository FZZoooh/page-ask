// These probes talk to the real backend and write to the real database. Require an explicit opt-in so a
// command that looks like a regression test cannot pollute a user's chat history.
export function requireRealConfig() {
  if (process.env.PAGEASK_ALLOW_REAL === '1') return;
  console.error(
    'This script talks to the real backend and writes to the real database.\n' +
      'Set PAGEASK_ALLOW_REAL=1 to run it (PowerShell: $env:PAGEASK_ALLOW_REAL=1; node ...).',
  );
  process.exit(2);
}
