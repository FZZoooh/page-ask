// Regression: caller-provided PDF limits must never exceed the hard caps. The HTTP layer passes
// maxPages/maxChars straight from the request body, so a malicious caller could otherwise ask for
// 1e9 pages and make the parser walk the whole file.
// Run: node scripts/test-pdf-limits.mjs
import assert from 'node:assert/strict';
import { normalizePdfLimits } from '../server/pdf.mjs';

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

check('huge limits are clamped to 400 pages / 400k chars', () => {
  assert.deepEqual(normalizePdfLimits({ maxPages: 1e9, maxChars: 1e9 }), {
    maxPages: 400,
    maxChars: 400_000,
  });
});

check('smaller limits are preserved and floored', () => {
  assert.deepEqual(normalizePdfLimits({ maxPages: 10.9, maxChars: 1200 }), {
    maxPages: 10,
    maxChars: 1200,
  });
});

check('invalid / missing limits fall back to the hard caps', () => {
  for (const value of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 'nope']) {
    assert.deepEqual(normalizePdfLimits({ maxPages: value, maxChars: value }), {
      maxPages: 400,
      maxChars: 400_000,
    });
  }
});

check('numeric strings are accepted then clamped', () => {
  assert.deepEqual(normalizePdfLimits({ maxPages: '12', maxChars: '999999999' }), {
    maxPages: 12,
    maxChars: 400_000,
  });
});

process.exit(failed ? 1 : 0);
