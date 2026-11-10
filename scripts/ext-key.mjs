// One-time setup: generate the RSA key pair that pins the extension ID.
//
// The public half is committed as extension-key.json (read by wxt.config.ts and the backend), so
// the ID no longer depends on the folder the extension is loaded from. The private half is needed
// only to pack a .crx later and stays outside the repo, in the user config dir.
//
// Refuses to overwrite anything: a new key means a new extension ID, a fresh extension storage and
// the browser reloading the extension, so it must be a deliberate act (delete the files first).
//
// Usage: node scripts/ext-key.mjs [--pem <path>] [--no-pem]
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { EXTENSION_KEY_FILE, extensionIdFromKey } from '../server/extension-id.mjs';

const args = process.argv.slice(2);
const noPem = args.includes('--no-pem');
const pemArg = args.indexOf('--pem');
const pemPath =
  pemArg >= 0
    ? resolve(args[pemArg + 1] ?? '.')
    : join(homedir(), '.config', 'righthandman', 'extension-key.pem');

if (existsSync(EXTENSION_KEY_FILE)) {
  console.error(`refusing to overwrite ${EXTENSION_KEY_FILE}: that would change the extension ID`);
  console.error('delete it deliberately first (and expect to reload the extension) if you really want a new one');
  process.exit(1);
}
if (!noPem && existsSync(pemPath)) {
  console.error(`refusing to overwrite the private key ${pemPath}; pass --pem <path> or --no-pem`);
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const id = extensionIdFromKey(key);

// Private half first: a committed public key whose private half was never persisted can never
// pack a .crx, and the failure would only show up the day someone tries to.
if (!noPem) {
  const dir = dirname(pemPath);
  if (!dir.endsWith(sep)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(pemPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { encoding: 'utf8', mode: 0o600 });
}

writeFileSync(EXTENSION_KEY_FILE, `${JSON.stringify({ key }, null, 2)}\n`, 'utf8');

console.log(`extension id: ${id}`);
console.log(`wrote ${EXTENSION_KEY_FILE}  (commit this file)`);
if (!noPem) console.log(`wrote ${pemPath}  (private: never commit it; only needed to pack a .crx)`);
