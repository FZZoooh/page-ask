// Regression: an aborted PDF parse (Stop / 60s tool timeout) must reject quickly with the
// `cancelled` code instead of letting pdfjs finish the whole document.
// Run: node scripts/test-pdf-cancel.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPdfText, PdfError } from '../server/pdf.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bytes = new Uint8Array(readFileSync(join(root, 'test', 'sample.pdf')));

let failed = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${name}\n     ${err.stack ?? err.message}`);
  }
};

await check('already-aborted parse rejects with cancelled', async () => {
  const started = Date.now();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => extractPdfText(bytes, { signal: controller.signal }),
    (err) => {
      assert.ok(err instanceof PdfError, `expected PdfError, got ${err?.constructor?.name}`);
      assert.equal(err.code, 'cancelled');
      return true;
    },
  );
  assert.ok(Date.now() - started < 2000, 'cancellation must not wait for the parser');
});

await check('abort during page loop stops before the next page', async () => {
  const controller = new AbortController();
  let seen = 0;
  await assert.rejects(
    () =>
      extractPdfText(bytes, {
        signal: controller.signal,
        onProgress: () => {
          seen += 1;
          if (seen === 1) controller.abort();
        },
      }),
    (err) => err instanceof PdfError && err.code === 'cancelled',
  );
});

console.log(failed ? `\n${failed} failure(s)` : '\nall good');
process.exitCode = failed ? 1 : 0;
