import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join, parse, relative, sep } from 'node:path';
import { dataDir } from './settings.mjs';

const FILE_LIMIT = 1024 * 1024;
const FILE_COUNT_LIMIT = 100;
const WORKSPACE_LIMIT = 10 * FILE_LIMIT;
const EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'html', 'htm', 'css', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'json', 'csv', 'tsv',
  'yaml', 'yml', 'xml', 'log', 'ini', 'toml', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'sql', 'tex',
]);
const TEMP_NAME = /^\.workspace-[a-f0-9]{32}\.tmp$/;
const STATUS = {
  'workspace.invalid_name': 400,
  'workspace.unsupported': 415,
  'workspace.invalid_text': 400,
  'workspace.too_large': 413,
  'workspace.full': 413,
  'workspace.not_found': 404,
  'workspace.unsafe_entry': 400,
  'workspace.exists': 409,
  'workspace.no_match': 409,
  'workspace.ambiguous': 409,
};

export class WorkspaceError extends Error {
  constructor(code, status = STATUS[code] ?? 400, message = code) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
    this.status = status;
  }
}

function fail(code) {
  throw new WorkspaceError(`workspace.${code}`);
}

const BANNED_CHARS = /[\\/:<>"'`|?*\u0000-\u001f\u007f-\u009f]/u;
const RESERVED_STEM = /^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[0-9¹²³]?|LPT[0-9¹²³]?)$/iu;
const NAME_BYTE_LIMIT = 180;

function validateName(name) {
  if (typeof name !== 'string' || !name || !name.isWellFormed() || Buffer.byteLength(name, 'utf8') > NAME_BYTE_LIMIT
    || name.startsWith('.') || /[. ]$/.test(name)
    || BANNED_CHARS.test(name)) {
    fail('invalid_name');
  }
  if (RESERVED_STEM.test(name.split('.')[0].trimEnd())) fail('invalid_name');
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  if (!EXTENSIONS.has(extension)) fail('unsupported');
}

/**
 * Derive a valid flat workspace filename from an arbitrary display name (attachment imports), keeping
 * the original whenever it can: coerces the extension to an allowed one, replaces characters Windows
 * filenames reject, trims to the same byte cap validateName enforces. Never throws, so a copied
 * attachment succeeds in one call even when its name would not have been accepted as is.
 */
export function suggestName(raw) {
  const segment = (typeof raw === 'string' ? raw : '').split(/[\\/]/).pop().replace(BANNED_CHARS, '-');
  const dot = segment.lastIndexOf('.');
  // A leading dot (".env") belongs to the stem, not the extension.
  let stem = (dot > 0 ? segment.slice(0, dot) : segment).replace(/^[.\s]+/, '').replace(/[.\s]+$/, '').trim();
  let extension = dot > 0 ? segment.slice(dot + 1).toLowerCase() : '';
  if (!EXTENSIONS.has(extension)) extension = 'txt';
  if (!stem) stem = 'file';
  if (RESERVED_STEM.test(stem.split('.')[0])) stem = `file-${stem}`;
  // Trim by code points so a surrogate pair never gets split in half.
  while (Buffer.byteLength(`${stem}.${extension}`, 'utf8') > NAME_BYTE_LIMIT && stem.length > 0) {
    stem = Array.from(stem).slice(0, -1).join('').replace(/[.\s]+$/, '');
  }
  const name = stem ? `${stem}.${extension}` : 'file.txt';
  try {
    validateName(name);
    return name;
  } catch {
    return 'file.txt';
  }
}

function validateText(text) {
  if (typeof text !== 'string' || !text.isWellFormed()
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text)) {
    fail('invalid_text');
  }
}

function encode(text) {
  validateText(text);
  if (Buffer.byteLength(text, 'utf8') > FILE_LIMIT) fail('too_large');
  return Buffer.from(text, 'utf8');
}

function statOrNull(path) {
  try {
    return lstatSync(path);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    if (err.code === 'ELOOP' || err.code === 'ENOTDIR') fail('unsafe_entry');
    throw err;
  }
}

function assertFile(stat) {
  if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) fail('unsafe_entry');
}

function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}

function assertUnchanged(path, previous) {
  const current = statOrNull(path);
  assertFile(current);
  if (!sameFile(current, previous) || current.size !== previous.size
    || current.mtimeMs !== previous.mtimeMs || current.ctimeMs !== previous.ctimeMs) fail('unsafe_entry');
}

// Closing a written handle can refresh timestamps lazily on Windows, so compare identity and length only.
function assertSameEntry(path, previous) {
  const current = statOrNull(path);
  assertFile(current);
  if (!sameFile(current, previous) || current.size !== previous.size) fail('unsafe_entry');
}

// Check ancestors individually: recursive mkdir and realpath alone would accept a junction out of dataDir.
function ensureDirectory(directory, create) {
  const root = parse(directory).root;
  const parts = relative(root, directory).split(sep).filter(Boolean);
  let path = root;
  for (const part of ['', ...parts]) {
    if (part) path = join(path, part);
    let stat = statOrNull(path);
    if (!stat) {
      if (!create) return false;
      try {
        mkdirSync(path, { mode: 0o700 });
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
      stat = statOrNull(path);
    }
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) fail('unsafe_entry');
  }
  return true;
}

function scan(directory) {
  const entries = readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    const stat = statOrNull(path);
    assertFile(stat);
    const temporary = TEMP_NAME.test(name);
    // Writes are synchronous; staging files seen by the next operation were abandoned by a crash.
    if (temporary) {
      if (!ensureDirectory(directory, false)) fail('unsafe_entry');
      assertUnchanged(path, stat);
      unlinkSync(path);
      return [];
    }
    if (!temporary) {
      try {
        validateName(name);
      } catch (err) {
        if (!(err instanceof WorkspaceError)) throw err;
        fail('unsafe_entry');
      }
    }
    if (stat.size > FILE_LIMIT) fail('too_large');
    return { name, stat, temporary };
  });
  const names = new Set();
  for (const entry of entries.filter((entry) => !entry.temporary)) {
    const key = entry.name.toLowerCase();
    if (names.has(key)) fail('unsafe_entry');
    names.add(key);
  }
  return entries;
}

function artifact(entries, name) {
  return entries.find((entry) => !entry.temporary && entry.name.toLowerCase() === name.toLowerCase());
}

function metadata(name, stat) {
  return { name, size: stat.size, modifiedAt: stat.mtime.toISOString() };
}

function readBytes(directory, entry) {
  if (!entry) fail('not_found');
  if (!ensureDirectory(directory, false)) fail('not_found');
  const path = join(directory, entry.name);
  assertUnchanged(path, entry.stat);
  let fd;
  try {
    // NOFOLLOW plus descriptor identity prevents a file link swapped between lstat and open from being read.
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (err) {
    if (err.code === 'ENOENT') fail('not_found');
    if (err.code === 'ELOOP') fail('unsafe_entry');
    throw err;
  }
  try {
    const stat = fstatSync(fd);
    assertFile(stat);
    if (!sameFile(stat, entry.stat)) fail('unsafe_entry');
    if (stat.size > FILE_LIMIT) fail('too_large');
    const buffer = Buffer.alloc(FILE_LIMIT + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, size);
      if (!count) break;
      size += count;
    }
    if (size > FILE_LIMIT) fail('too_large');
    assertUnchanged(path, stat);
    const bytes = buffer.subarray(0, size);
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      fail('invalid_text');
    }
    validateText(text);
    return { bytes, text };
  } finally {
    closeSync(fd);
  }
}

function checkQuota(entries, existing, size) {
  const count = entries.filter((entry) => !entry.temporary).length + (existing ? 0 : 1);
  const total = entries.reduce((sum, entry) => sum + entry.stat.size, 0) - (existing?.stat.size ?? 0) + size;
  if (count > FILE_COUNT_LIMIT || total > WORKSPACE_LIMIT) fail('full');
}

function store(directory, entries, name, bytes, overwrite) {
  const existing = artifact(entries, name);
  if (existing && !overwrite) fail('exists');
  checkQuota(entries, existing, bytes.length);
  if (!ensureDirectory(directory, false)) fail('not_found');
  if (existing) assertUnchanged(join(directory, existing.name), existing.stat);
  const actualName = existing?.name ?? name;
  const target = join(directory, actualName);
  const staging = existing ? join(directory, `.workspace-${randomBytes(16).toString('hex')}.tmp`) : target;
  let fd;
  let owned;
  let committed = false;
  try {
    try {
      fd = openSync(staging, 'wx', 0o600);
    } catch (err) {
      if (err.code === 'EEXIST') {
        assertFile(statOrNull(staging));
        fail('exists');
      }
      throw err;
    }
    owned = fstatSync(fd);
    assertFile(owned);
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error('Workspace write made no progress');
      offset += count;
    }
    fsyncSync(fd);
    const stat = fstatSync(fd);
    assertFile(stat);
    closeSync(fd);
    fd = undefined;
    if (!ensureDirectory(directory, false)) fail('not_found');
    assertSameEntry(staging, stat);
    if (existing) {
      assertUnchanged(target, existing.stat);
      renameSync(staging, target);
    }
    committed = true;
    return metadata(actualName, stat);
  } finally {
    try {
      if (fd !== undefined) closeSync(fd);
    } finally {
      if (!committed && owned && ensureDirectory(directory, false)) {
        const current = statOrNull(staging);
        if (current && sameFile(current, owned) && current.isFile() && current.nlink === 1) unlinkSync(staging);
      }
    }
  }
}

function directoryFor(conversationId) {
  if (typeof conversationId !== 'string' || !conversationId || !conversationId.isWellFormed()) fail('invalid_name');
  const hash = createHash('sha256').update(conversationId, 'utf8').digest('hex');
  return join(dataDir, 'workspaces', hash);
}

export function workspaceFor(conversationId) {
  const directory = directoryFor(conversationId);
  const entries = (create) => {
    if (!ensureDirectory(directory, create)) return null;
    return scan(directory);
  };
  return {
    list() {
      return entries(true).filter((entry) => !entry.temporary)
        .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
        .map((entry) => metadata(entry.name, entry.stat));
    },
    read(name) {
      validateName(name);
      return readBytes(directory, artifact(entries(true), name)).text;
    },
    write(name, content, { overwrite = false } = {}) {
      validateName(name);
      const bytes = encode(content);
      return store(directory, entries(true), name, bytes, overwrite);
    },
    edit(name, oldText, newText, { replaceAll = false } = {}) {
      validateName(name);
      validateText(oldText);
      validateText(newText);
      if (!oldText) fail('invalid_text');
      const currentEntries = entries(true);
      const existing = artifact(currentEntries, name);
      const { text } = readBytes(directory, existing);
      const first = text.indexOf(oldText);
      if (first === -1) fail('no_match');
      if (!replaceAll && text.indexOf(oldText, first + 1) !== -1) fail('ambiguous');
      let matches = 1;
      if (replaceAll) {
        let index = first;
        while ((index = text.indexOf(oldText, index + oldText.length)) !== -1) matches += 1;
      }
      // Check expansion before allocating: a small repeated pattern can otherwise produce gigabytes of text.
      const size = Buffer.byteLength(text, 'utf8')
        + matches * (Buffer.byteLength(newText, 'utf8') - Buffer.byteLength(oldText, 'utf8'));
      if (size > FILE_LIMIT) fail('too_large');
      checkQuota(currentEntries, existing, size);
      const updated = replaceAll
        ? text.replaceAll(oldText, () => newText)
        : text.slice(0, first) + newText + text.slice(first + oldText.length);
      return store(directory, currentEntries, name, encode(updated), true);
    },
    content(name) {
      validateName(name);
      const currentEntries = entries(false);
      if (!currentEntries) fail('not_found');
      return readBytes(directory, artifact(currentEntries, name)).bytes;
    },
  };
}

export function removeWorkspace(conversationId) {
  const directory = directoryFor(conversationId);
  if (!ensureDirectory(directory, false)) return;
  const entries = scan(directory);
  for (const entry of entries) {
    if (!ensureDirectory(directory, false)) fail('unsafe_entry');
    const path = join(directory, entry.name);
    assertUnchanged(path, entry.stat);
    unlinkSync(path);
  }
  if (!ensureDirectory(directory, false)) fail('unsafe_entry');
  rmdirSync(directory);
}
