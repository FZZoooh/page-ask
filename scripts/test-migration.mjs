// Regression: an old database (pre-tool-call schema) must be upgraded in place, without losing rows,
// and the pre-rename config dir / database file must be migrated on startup.
// Run: node scripts/test-migration.mjs
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestConfig } from './temp-config.mjs';

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !extra ? '' : ` — ${extra}`}`);
  if (!ok) failures += 1;
};

// --- config dir rename: ~/.config/pageask is copied to ~/.config/righthandman ---
const legacyHome = mkdtempSync(join(tmpdir(), 'pageask-rename-'));
const legacyConfigDir = join(legacyHome, '.config', 'pageask');
const legacyDataDir = join(legacyHome, 'data');
mkdirSync(legacyConfigDir, { recursive: true });
const legacySettingsFile = join(legacyConfigDir, 'settings.json');
writeFileSync(
  legacySettingsFile,
  `${JSON.stringify(
    {
      baseUrl: 'http://127.0.0.1:1',
      model: 'old-model',
      apiKey: 'sk-old',
      state: 'off',
      port: 8899,
      token: 'old-token',
      dataDir: legacyDataDir,
    },
    null,
    2,
  )}\n`,
);
writeFileSync(join(legacyConfigDir, 'extension-key.pem'), 'old-private-key');

const savedHome = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
process.env.USERPROFILE = legacyHome;
process.env.HOME = legacyHome;
const settingsModule = await import(`../server/settings.mjs?rename=${Date.now()}`);
const renamedSettings = settingsModule.readSettings();
const newConfigDir = join(legacyHome, '.config', 'righthandman');

check('config dir migrated to righthandman', settingsModule.configDir === newConfigDir && existsSync(join(newConfigDir, 'settings.json')));
check(
  'settings preserved',
  renamedSettings.port === 8899 && renamedSettings.token === 'old-token' && renamedSettings.apiKey === 'sk-old',
);
check('custom dataDir applies on the first start', settingsModule.dataDir === legacyDataDir);
check('private key copied', existsSync(join(newConfigDir, 'extension-key.pem')));
check('old config dir kept as backup', existsSync(legacySettingsFile));
process.env.USERPROFILE = savedHome.USERPROFILE;
process.env.HOME = savedHome.HOME;
rmSync(legacyHome, { recursive: true, force: true });

const cfg = makeTestConfig({ dataDir: undefined });

const legacyDbPath = join(cfg.dataDir, 'pageask.db');
const dbPath = join(cfg.dataDir, 'righthandman.db');
const old = new DatabaseSync(legacyDbPath);
old.exec(`
  CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    reasoning TEXT,
    created_at INTEGER NOT NULL,
    tokens_in INTEGER,
    tokens_out INTEGER,
    ms INTEGER
  );
`);
old.prepare('INSERT INTO conversations (id,url,title,created_at,updated_at) VALUES (?,?,?,?,?)').run(
  'conv-old',
  'https://example.com/a',
  'old',
  1,
  2,
);
old.prepare('INSERT INTO messages (id,conversation_id,role,content,created_at) VALUES (?,?,?,?,?)').run(
  'msg-old',
  'conv-old',
  'user',
  'hello',
  3,
);
old.close();

// Import after creating the old file: db.mjs migrates the file name and schema at import time.
const db = await import(`../server/db.mjs?migration=${Date.now()}`);
check('database renamed to righthandman.db', existsSync(dbPath) && !existsSync(legacyDbPath));
check('dbFile points at the new name', db.dbFile === dbPath);
const raw = new DatabaseSync(dbPath);
const columns = new Set(raw.prepare('PRAGMA table_info(messages)').all().map((r) => r.name));
for (const name of [
  'tool_calls',
  'tool_call_id',
  'tool_name',
  'tool_args',
  'aborted',
  'tool_failed',
  'image_path',
  'process_ms',
  'response_id',
  'page_context',
]) {
  check(`migration adds ${name}`, columns.has(name));
}
const rows = raw.prepare('SELECT role, content FROM messages').all();
check('migration keeps existing rows', rows.length === 1 && rows[0].content === 'hello');
check('aborted defaults to 0', raw.prepare('SELECT aborted FROM messages').get().aborted === 0);

raw.close();
db.closeDb();
cfg.cleanup();
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall good');
