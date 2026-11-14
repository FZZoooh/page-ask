import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, join } from 'node:path';
import { makeTestConfig } from './temp-config.mjs';

const previousHome = process.env.HOME;
const previousProfile = process.env.USERPROFILE;
const config = makeTestConfig();
const moduleUrl = new URL('../server/workspace.mjs', import.meta.url);
const { workspaceFor, removeWorkspace, WorkspaceError } = await import(moduleUrl);
const root = join(config.dataDir, 'workspaces');
const fileLimit = 1024 * 1024;
const folder = (id) => join(root, createHash('sha256').update(id, 'utf8').digest('hex'));
let groups = 0;
let skipped = 0;

function check(label, run) {
  run();
  groups += 1;
  console.log(`ok ${label}`);
}

function error(code, status, run) {
  assert.throws(run, (err) => {
    assert.ok(err instanceof WorkspaceError);
    assert.equal(err.name, 'WorkspaceError');
    assert.equal(err.code, `workspace.${code}`);
    assert.equal(err.status, status);
    assert.equal(typeof err.message, 'string');
    assert.ok(err.message.length);
    return true;
  });
}

function unsafeEveryOperation(id) {
  const workspace = workspaceFor(id);
  for (const run of [
    () => workspace.list(),
    () => workspace.read('safe.txt'),
    () => workspace.content('safe.txt'),
    () => workspace.write('new.txt', 'new'),
    () => workspace.write('safe.txt', 'replacement', { overwrite: true }),
    () => workspace.edit('safe.txt', 'safe', 'changed'),
    () => removeWorkspace(id),
  ]) error('unsafe_entry', 400, run);
}

function optionalLink(label, setup, run, cleanup) {
  try {
    setup();
  } catch (err) {
    if (!['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(err.code)) throw err;
    skipped += 1;
    console.log(`skip ${label}: ${err.code}`);
    return;
  }
  try {
    check(label, run);
  } finally {
    cleanup();
  }
}

function injectedFailure(method, replacement, run) {
  const original = fs[method];
  fs[method] = (...args) => replacement(original, ...args);
  syncBuiltinESMExports();
  try {
    run();
  } finally {
    fs[method] = original;
    syncBuiltinESMExports();
  }
}

try {
  check('construction, content and deletion never create directories', () => {
    fs.rmdirSync(config.dataDir);
    const workspace = workspaceFor('lazy');
    assert.equal(fs.existsSync(config.dataDir), false);
    error('not_found', 404, () => workspace.content('missing.txt'));
    removeWorkspace('lazy');
    assert.equal(fs.existsSync(config.dataDir), false);
    assert.deepEqual(workspace.list(), []);
    assert.ok(fs.lstatSync(folder('lazy')).isDirectory());
    assert.equal(fs.existsSync(folder('other')), false);
  });

  check('filenames are validated before any filesystem effects', () => {
    const workspace = workspaceFor('invalid');
    const invalid = [
      '', '.', '..', '.hidden.txt', '../x.txt', 'a/b.txt', 'a\\b.txt', '/x.txt', 'C:\\x.txt',
      'x.txt:stream', 'x:stream.txt', 'x.txt.', 'x.txt ', 'x\n.txt', 'x\0.txt', 'x\u007f.txt', 'x\u0085.txt',
      'x".txt', "x'.txt", 'x`.txt', 'x*.txt', 'x?.txt', 'x<.txt', 'x>.txt', 'x|.txt',
      'CON.txt', 'con.md', 'CON.any.txt', 'CON .txt', 'PRN.txt', 'AUX.txt', 'NUL.txt', 'COM.txt', 'LPT.txt',
      'COM0.txt', 'COM1.txt', 'COM9.txt', 'LPT0.txt', 'LPT1.txt', 'LPT9.txt', 'COM¹.txt', 'LPT².txt',
      'COM³.txt', 'CONIN$.txt', 'CONOUT$.txt', 'CLOCK$.txt', `${'a'.repeat(177)}.txt`,
      `${'文'.repeat(59)}.txt`, 'bad\ud800.txt', null, undefined, 12,
    ];
    for (const name of invalid) {
      for (const run of [
        () => workspace.read(name),
        () => workspace.write(name, 'text'),
        () => workspace.edit(name, 'text', 'next'),
        () => workspace.content(name),
      ]) error('invalid_name', 400, run);
    }
    for (const name of ['no-extension', 'file.exe', 'file.pdf', 'file.docx', 'file.xlsx', 'file.png', 'x.txt.exe']) {
      error('unsupported', 415, () => workspace.write(name, 'text'));
      error('unsupported', 415, () => workspace.read(name));
      error('unsupported', 415, () => workspace.edit(name, 'a', 'b'));
      error('unsupported', 415, () => workspace.content(name));
    }
    assert.equal(fs.existsSync(folder('invalid')), false);
    for (const id of ['', null, undefined, 42, '\ud800']) {
      error('invalid_name', 400, () => workspaceFor(id));
      error('invalid_name', 400, () => removeWorkspace(id));
    }
  });

  check('list, read, write and edit invoke lazy creation independently', () => {
    const read = workspaceFor('lazy-read');
    error('not_found', 404, () => read.read('missing.txt'));
    assert.ok(fs.existsSync(folder('lazy-read')));
    const edit = workspaceFor('lazy-edit');
    error('not_found', 404, () => edit.edit('missing.txt', 'old', 'new'));
    assert.ok(fs.existsSync(folder('lazy-edit')));
    const write = workspaceFor('lazy-write');
    write.write('created.txt', 'text');
    assert.ok(fs.existsSync(folder('lazy-write')));
  });

  const workspace = workspaceFor('crud');
  check('UTF-8 CRUD, metadata, exact replacements and Windows case aliases', () => {
    const content = '\ufeffHello 世界\t\r\nrepeat repeat';
    const created = workspace.write('notes.MD', content);
    assert.deepEqual(Object.keys(created).sort(), ['modifiedAt', 'name', 'size']);
    assert.equal(created.name, 'notes.MD');
    assert.equal(created.size, Buffer.byteLength(content));
    assert.equal(new Date(created.modifiedAt).toISOString(), created.modifiedAt);
    assert.deepEqual(workspace.list(), [created]);
    assert.equal(workspace.read('NOTES.md'), content);
    assert.deepEqual(workspace.content('notes.md'), Buffer.from(content));
    assert.ok(Buffer.isBuffer(workspace.content('notes.MD')));
    error('exists', 409, () => workspace.write('NOTES.md', 'clobber'));
    assert.equal(workspace.read('notes.MD'), content);
    error('invalid_text', 400, () => workspace.edit('notes.MD', '', 'x'));
    error('no_match', 409, () => workspace.edit('notes.MD', 'absent', 'x'));
    error('ambiguous', 409, () => workspace.edit('notes.MD', 'repeat', 'x'));
    const edited = workspace.edit('notes.md', '世界', 'world');
    assert.equal(edited.name, 'notes.MD');
    assert.equal(workspace.read('notes.MD'), content.replace('世界', 'world'));
    workspace.edit('notes.MD', 'repeat', '$&', { replaceAll: true });
    assert.equal(workspace.read('notes.MD'), '\ufeffHello world\t\r\n$& $&');
    workspace.edit('notes.MD', '$&', '', { replaceAll: true });
    assert.equal(workspace.read('notes.MD'), '\ufeffHello world\t\r\n ');
    workspace.write('NOTES.md', '', { overwrite: true });
    assert.equal(workspace.read('notes.MD'), '');
    assert.equal(workspace.list()[0].size, 0);
    workspace.write('overlap.txt', 'aaa');
    error('ambiguous', 409, () => workspace.edit('overlap.txt', 'aa', 'x'));
    workspace.edit('overlap.txt', 'aa', 'x', { replaceAll: true });
    assert.equal(workspace.read('overlap.txt'), 'xa');
    error('not_found', 404, () => workspace.read('absent.txt'));
    error('not_found', 404, () => workspace.content('absent.txt'));
    error('not_found', 404, () => workspace.edit('absent.txt', 'a', 'b'));
  });

  check('all allowlisted extensions, byte-length boundary and literal non-path names', () => {
    const allowed = workspaceFor('extensions');
    const extensions = 'txt md markdown html htm css js mjs ts tsx jsx json csv tsv yaml yml xml log ini toml py rs go java c cpp h sql tex'.split(' ');
    for (const ext of extensions) allowed.write(`file.${ext}`, 'text');
    const boundary = `${'a'.repeat(176)}.txt`;
    assert.equal(Buffer.byteLength(boundary), 180);
    allowed.write(boundary, 'boundary');
    allowed.write('文档.txt', '中文');
    allowed.write('%2e%2e%2f.txt', 'literal, not URL-decoded');
    assert.equal(allowed.read('%2e%2e%2f.txt'), 'literal, not URL-decoded');
    assert.deepEqual(allowed.list().map((entry) => entry.name), fs.readdirSync(folder('extensions')).sort());
  });

  check('conversation IDs are hashed without aliases and remain isolated', () => {
    for (const id of ['../escape', 'same', 'SAME', 'same ', 'https://example.test/a?x=1']) {
      workspaceFor(id).write('same.txt', id);
      assert.equal(workspaceFor(id).read('same.txt'), id);
      assert.ok(fs.existsSync(join(folder(id), 'same.txt')));
    }
    assert.equal(fs.existsSync(join(config.dataDir, 'escape')), false);
  });

  check('binary controls, nonstrings and malformed Unicode never mutate storage', () => {
    const binary = workspaceFor('binary');
    const invalid = [null, undefined, 5, Buffer.from('text'), {}, '\ud800', '\udc00'];
    for (let code = 0; code <= 0x9f; code += 1) {
      if (code < 0x20 && ![9, 10, 13].includes(code) || code >= 0x7f) invalid.push(`a${String.fromCharCode(code)}b`);
    }
    for (const text of invalid) error('invalid_text', 400, () => binary.write('bad.txt', text));
    assert.equal(fs.existsSync(folder('binary')), false);
    binary.write('safe.txt', 'safe');
    for (const text of invalid) {
      error('invalid_text', 400, () => binary.write('safe.txt', text, { overwrite: true }));
      error('invalid_text', 400, () => binary.edit('safe.txt', 'safe', text));
      error('invalid_text', 400, () => binary.edit('safe.txt', text, 'new'));
    }
    assert.equal(binary.read('safe.txt'), 'safe');
    for (const bytes of [Buffer.from([0xff, 0xfe]), Buffer.from([0xc0, 0xaf]), Buffer.from([0]), Buffer.from('a\u0085b')]) {
      fs.writeFileSync(join(folder('binary'), 'external.txt'), bytes);
      error('invalid_text', 400, () => binary.read('external.txt'));
      error('invalid_text', 400, () => binary.content('external.txt'));
    }
    fs.unlinkSync(join(folder('binary'), 'external.txt'));
  });

  check('1 MiB UTF-8 boundary and failed write/edit validation preserve original bytes', () => {
    const sized = workspaceFor('size');
    error('too_large', 413, () => sized.write('new.txt', 'x'.repeat(fileLimit + 1)));
    assert.equal(fs.existsSync(folder('size')), false);
    const text = `${'文'.repeat(Math.floor(fileLimit / 3))}x`;
    assert.equal(Buffer.byteLength(text), fileLimit);
    assert.equal(sized.write('limit.txt', text).size, fileLimit);
    assert.equal(sized.read('limit.txt'), text);
    const before = sized.list();
    error('too_large', 413, () => sized.write('limit.txt', text + 'x', { overwrite: true }));
    error('too_large', 413, () => sized.edit('limit.txt', 'x', 'xx'));
    assert.deepEqual(sized.list(), before);
    assert.equal(sized.read('limit.txt'), text);
    sized.write('expansion.txt', 'x'.repeat(fileLimit));
    error('too_large', 413, () => sized.edit('expansion.txt', 'x', 'x'.repeat(fileLimit), { replaceAll: true }));
    assert.equal(sized.read('expansion.txt'), 'x'.repeat(fileLimit));
    fs.writeFileSync(join(folder('size'), 'external.txt'), Buffer.alloc(fileLimit + 1, 0x61));
    error('too_large', 413, () => sized.read('external.txt'));
    error('too_large', 413, () => sized.content('external.txt'));
    fs.unlinkSync(join(folder('size'), 'external.txt'));
  });

  check('100-file limit permits overwrite and edit but not new artifacts', () => {
    const counted = workspaceFor('count');
    for (let index = 0; index < 100; index += 1) counted.write(`file-${index}.txt`, 'a');
    assert.equal(counted.list().length, 100);
    error('full', 413, () => counted.write('extra.txt', ''));
    counted.write('file-0.txt', 'b', { overwrite: true });
    counted.edit('file-1.txt', 'a', 'c');
    assert.equal(counted.read('file-0.txt'), 'b');
    assert.equal(counted.read('file-1.txt'), 'c');
    assert.equal(fs.existsSync(join(folder('count'), 'extra.txt')), false);
  });

  check('10 MiB quota subtracts the replaced file and rejects growth before mutation', () => {
    const quota = workspaceFor('quota');
    const text = 'x'.repeat(fileLimit);
    for (let index = 0; index < 10; index += 1) quota.write(`file-${index}.txt`, text);
    quota.write('empty.txt', '');
    assert.equal(quota.list().reduce((sum, entry) => sum + entry.size, 0), 10 * fileLimit);
    error('full', 413, () => quota.write('extra.txt', 'x'));
    error('full', 413, () => quota.write('empty.txt', 'x', { overwrite: true }));
    quota.write('file-0.txt', text.slice(1), { overwrite: true });
    quota.write('empty.txt', 'a', { overwrite: true });
    error('full', 413, () => quota.edit('empty.txt', 'a', 'ab'));
    assert.equal(quota.read('empty.txt'), 'a');
    assert.equal(fs.existsSync(join(folder('quota'), 'extra.txt')), false);
  });

  check('a timestamp refresh after closing the write handle is not a replaced file', () => {
    const stamps = workspaceFor('timestamps');
    injectedFailure('lstatSync', (original, path) => {
      const stat = original(path);
      if (!stat || !basename(String(path)).startsWith('.workspace-')) return stat;
      const copy = Object.create(Object.getPrototypeOf(stat), Object.getOwnPropertyDescriptors(stat));
      Object.defineProperty(copy, 'mtimeMs', { value: stat.mtimeMs + 1000 });
      Object.defineProperty(copy, 'ctimeMs', { value: stat.ctimeMs + 1000 });
      return copy;
    }, () => {
      stamps.write('stamped.txt', 'safe');
    });
    assert.equal(stamps.read('stamped.txt'), 'safe');
    stamps.write('stamped.txt', 'replaced', { overwrite: true });
    assert.equal(stamps.read('stamped.txt'), 'replaced');
  });

  check('abandoned staging files are removed before quota checks after restart', () => {
    const name = `.workspace-${'b'.repeat(32)}.tmp`;
    const staging = join(folder('quota'), name);
    fs.writeFileSync(staging, 'x'.repeat(fileLimit));
    const reopened = workspaceFor('quota');
    reopened.write('file-1.txt', 'x'.repeat(fileLimit), { overwrite: true });
    assert.equal(fs.existsSync(staging), false);
    assert.equal(reopened.list().reduce((sum, entry) => sum + entry.size, 0), 10 * fileLimit);
    assert.equal(reopened.read('file-1.txt'), 'x'.repeat(fileLimit));
  });

  check('failed partial writes and rename roll back without clobbering the original', () => {
    const rollback = workspaceFor('rollback');
    rollback.write('safe.txt', 'original');
    const before = rollback.list();
    const failure = new Error('injected storage failure');
    injectedFailure('writeSync', (original, fd, bytes, offset, length, position) => {
      original(fd, bytes, offset, Math.min(length, 2), position);
      throw failure;
    }, () => {
      assert.throws(() => rollback.write('new.txt', 'new content'), (err) => err === failure);
      assert.throws(() => rollback.write('safe.txt', 'replacement', { overwrite: true }), (err) => err === failure);
    });
    assert.deepEqual(rollback.list(), before);
    assert.deepEqual(fs.readdirSync(folder('rollback')), ['safe.txt']);
    injectedFailure('renameSync', () => { throw failure; }, () => {
      assert.throws(() => rollback.edit('safe.txt', 'original', 'next'), (err) => err === failure);
    });
    assert.equal(rollback.read('safe.txt'), 'original');
    assert.deepEqual(rollback.list(), before);
    assert.deepEqual(fs.readdirSync(folder('rollback')), ['safe.txt']);
  });

  check('internal temporary files cannot be listed or read as artifacts', () => {
    const temporary = workspaceFor('temporary');
    temporary.write('safe.txt', 'safe');
    const name = `.workspace-${'a'.repeat(32)}.tmp`;
    fs.writeFileSync(join(folder('temporary'), name), 'unfinished');
    assert.deepEqual(temporary.list().map((entry) => entry.name), ['safe.txt']);
    error('invalid_name', 400, () => temporary.read(name));
    error('invalid_name', 400, () => temporary.content(name));
    removeWorkspace('temporary');
    assert.equal(fs.existsSync(folder('temporary')), false);
  });

  check('directory and unexpected filename entries fail closed on every operation', () => {
    const unsafe = workspaceFor('entry-directory');
    unsafe.write('safe.txt', 'safe');
    const entry = join(folder('entry-directory'), 'nested.txt');
    fs.mkdirSync(entry);
    unsafeEveryOperation('entry-directory');
    assert.equal(fs.readFileSync(join(folder('entry-directory'), 'safe.txt'), 'utf8'), 'safe');
    fs.rmdirSync(entry);
    fs.writeFileSync(join(folder('entry-directory'), '.hidden.txt'), 'unexpected');
    unsafeEveryOperation('entry-directory');
    fs.unlinkSync(join(folder('entry-directory'), '.hidden.txt'));
    const missing = workspaceFor('blocked-directory');
    fs.writeFileSync(folder('blocked-directory'), 'not a directory');
    unsafeEveryOperation('blocked-directory');
    assert.equal(fs.readFileSync(folder('blocked-directory'), 'utf8'), 'not a directory');
    fs.unlinkSync(folder('blocked-directory'));
    assert.deepEqual(missing.list(), []);
  });

  const outside = join(config.root, 'outside.txt');
  fs.writeFileSync(outside, 'outside');
  const linkedId = 'entry-hardlink';
  workspaceFor(linkedId).write('safe.txt', 'safe');
  const linkedEntry = join(folder(linkedId), 'linked.txt');
  optionalLink('hard-linked files are rejected without changing their outside target',
    () => fs.linkSync(outside, linkedEntry),
    () => {
      assert.equal(fs.lstatSync(linkedEntry).nlink, 2);
      unsafeEveryOperation(linkedId);
      assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');
    },
    () => fs.unlinkSync(linkedEntry));

  const symlinkId = 'entry-symlink';
  workspaceFor(symlinkId).write('safe.txt', 'safe');
  const symbolicEntry = join(folder(symlinkId), 'linked.txt');
  optionalLink('symlink files are rejected without reading or mutating their outside target',
    () => fs.symlinkSync(outside, symbolicEntry, 'file'),
    () => {
      unsafeEveryOperation(symlinkId);
      assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');
    },
    () => fs.unlinkSync(symbolicEntry));

  const externalDirectory = join(config.root, 'outside-directory');
  fs.mkdirSync(externalDirectory);
  fs.writeFileSync(join(externalDirectory, 'safe.txt'), 'outside');
  const directoryLinkType = process.platform === 'win32' ? 'junction' : 'dir';
  const linkedDirectoryId = 'directory-link';
  optionalLink('conversation directory symlinks/junctions fail closed, including deletion',
    () => fs.symlinkSync(externalDirectory, folder(linkedDirectoryId), directoryLinkType),
    () => {
      unsafeEveryOperation(linkedDirectoryId);
      assert.deepEqual(fs.readdirSync(externalDirectory), ['safe.txt']);
      assert.equal(fs.readFileSync(join(externalDirectory, 'safe.txt'), 'utf8'), 'outside');
    },
    () => fs.unlinkSync(folder(linkedDirectoryId)));

  for (const directory of [root, config.dataDir]) {
    const saved = `${directory}-saved`;
    fs.renameSync(directory, saved);
    try {
      optionalLink(`managed ancestor symlinks/junctions are rejected: ${directory}`,
        () => fs.symlinkSync(saved, directory, directoryLinkType),
        () => unsafeEveryOperation('crud'),
        () => fs.unlinkSync(directory));
    } finally {
      fs.renameSync(saved, directory);
    }
  }

  const recreated = await import(`${moduleUrl.href}?recreated=1`);
  check('storage survives module recreation; removal only affects its managed conversation', () => {
    assert.deepEqual(recreated.workspaceFor('crud').list(), workspace.list());
    assert.equal(recreated.workspaceFor('crud').read('overlap.txt'), 'xa');
    recreated.removeWorkspace('crud');
    assert.equal(fs.existsSync(folder('crud')), false);
    assert.equal(workspaceFor('same').read('same.txt'), 'same');
    assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');
    recreated.removeWorkspace('crud');
    error('not_found', 404, () => workspace.content('overlap.txt'));
    assert.equal(fs.existsSync(folder('crud')), false);
    assert.deepEqual(workspace.list(), []);
    assert.deepEqual(recreated.workspaceFor('crud').list(), []);
  });

  console.log(`Workspace storage: ${groups} groups passed, ${skipped} permission-dependent checks skipped.`);
} finally {
  config.cleanup();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousProfile;
}
