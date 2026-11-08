/**
 * The extension ID is a pure function of the signing key, so both sides can agree on it without
 * touching build output: `wxt.config.ts` writes the public key from `extension-key.json` into the
 * manifest, and the backend derives the ID from that same file at startup.
 *
 * Chrome/Edge hash the key's DER (SPKI) bytes with SHA-256, keep the first 16 bytes and map each
 * nibble to `a`..`p`. An unpacked extension without a pinned key gets the same treatment applied
 * to its absolute install path, which is exactly the path dependence the pinned key removes.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** public half only; committed, so a fresh clone / CI can derive the ID before any build */
export const EXTENSION_KEY_FILE = join(REPO_ROOT, 'extension-key.json');

const ID_ALPHABET = 'abcdefghijklmnop';

/** Chrome's algorithm: sha256(base64-decode(key)) → first 16 bytes → one letter per nibble */
export function extensionIdFromKey(base64Key) {
  const encoded = String(base64Key ?? '').trim();
  if (!encoded) throw new Error('extension key is empty');
  // Buffer.from ignores junk silently (and accepts unpadded input), so reject anything that is not
  // canonical base64 before decoding; otherwise a truncated key can still hash to a plausible-looking ID.
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error('extension key is not valid base64');
  }
  const der = Buffer.from(encoded, 'base64');
  if (!der.length) throw new Error('extension key is not valid base64');
  const digest = createHash('sha256').update(der).digest();
  let id = '';
  for (let i = 0; i < 16; i += 1) {
    const byte = digest[i] ?? 0;
    id += ID_ALPHABET[byte >> 4] + ID_ALPHABET[byte & 0x0f];
  }
  return id;
}

/** the key string from extension-key.json, or '' when the file is missing/unreadable */
export function readExtensionKey(file = EXTENSION_KEY_FILE) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return typeof parsed?.key === 'string' ? parsed.key.trim() : '';
  } catch {
    return '';
  }
}

/**
 * Resolve the ID the backend should whitelist. `source` is reported at startup and in /health so
 * a 403 can be traced to "no key generated yet" instead of a mysterious origin mismatch.
 * `file` exists so tests can point at a fixture instead of the committed key.
 */
export function resolveExtensionId(file = EXTENSION_KEY_FILE) {
  const key = readExtensionKey(file);
  if (!key) return { id: '', source: 'missing' };
  try {
    return { id: extensionIdFromKey(key), source: 'extension-key.json' };
  } catch {
    return { id: '', source: 'invalid' };
  }
}
