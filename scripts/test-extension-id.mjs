// Regression: the extension ID is derived from extension-key.json by both the build and the backend,
// so the derivation is pinned with a known-answer test. Run: node scripts/test-extension-id.mjs
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EXTENSION_KEY_FILE,
  extensionIdFromKey,
  readExtensionKey,
  resolveExtensionId,
} from '../server/extension-id.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'pageask-ext-id-'));

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !extra ? '' : ` — ${extra}`}`);
  if (!ok) failures += 1;
};

// RSA-2048 SPKI DER, test-only: the private half was discarded right after this constant was written.
const FIXTURE_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAq45nDSq7oX/1NrjrQZ0lgj9I9vfJg+owDYJGfvskCi7K95qHf2+xOjW+9+lXlfwJ4CWq8JWUtRYl8oqTPlXM9yuQYohNFKOxRET4Qs3q+dsDZ4vYgO0klGbnVqPX93eBcmBrFIsW688+NmUUlwrXk88v16uqnJRMZzjLG7gJAUleD8vSk2Hyw9PDyjwyLc+v4hNK6dEAJp0Ksh3OxKFxtTNDpcl8PAhmHYVzTtUP6rEL3eGHesHgZOUR+qrhjvh0Q2y4wTE+55qhACcVF0hcj92yp+AvNtpepKkacaUBSu+TJF64dH18XvzohQWfcCBK9LYQ8HZ2i+oNRZYjA74y2wIDAQAB';
const FIXTURE_ID = 'himdmghofdclfbkfiimjhfimakeieine';

const id = extensionIdFromKey(FIXTURE_KEY);
check('known-answer: key hashes to the ID Chrome would assign', id === FIXTURE_ID, `got ${id}`);
check('ID is 32 letters in a..p', /^[a-p]{32}$/.test(id), id);

const fixtureFile = join(tmp, 'fixture.json');
writeFileSync(fixtureFile, JSON.stringify({ key: FIXTURE_KEY }), 'utf8');
check('readExtensionKey reads the committed shape', readExtensionKey(fixtureFile) === FIXTURE_KEY);
check(
  'resolveExtensionId reports the source',
  resolveExtensionId(fixtureFile).source === 'extension-key.json',
  resolveExtensionId(fixtureFile).source,
);

const missing = resolveExtensionId(join(tmp, 'nope.json'));
check('missing file fails closed', missing.id === '' && missing.source === 'missing', missing.source);

const brokenFile = join(tmp, 'broken.json');
writeFileSync(brokenFile, '{ not json', 'utf8');
check('unparsable file fails closed', resolveExtensionId(brokenFile).source === 'missing');

const badKeyFile = join(tmp, 'bad-key.json');
writeFileSync(badKeyFile, JSON.stringify({ key: '!!!' }), 'utf8');
check('junk key is reported invalid, not hashed', resolveExtensionId(badKeyFile).source === 'invalid');

let rejectedShort = false;
try {
  extensionIdFromKey('abc');
} catch {
  rejectedShort = true;
}
check('non-canonical base64 is rejected instead of silently decoded', rejectedShort);

// The real file must agree with itself; a missing/invalid one would otherwise only fail at runtime.
const real = resolveExtensionId();
check(
  `committed ${EXTENSION_KEY_FILE} yields an ID`,
  real.source === 'extension-key.json' && /^[a-p]{32}$/.test(real.id),
  `${real.source} ${real.id}`,
);

rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} failure(s)` : '\nall good');
process.exitCode = failures ? 1 : 0;
