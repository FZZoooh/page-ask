// Regression: an old database (pre-tool-call schema) must be upgraded in place, without losing rows.
// Run: node scripts/test-migration.mjs
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { makeTestConfig } from './temp-config.mjs';

const cfg = makeTestConfig({ dataDir: undefined });
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !extra ? '' : ` — ${extra}`}`);
  if (!ok) failures += 1;
};

const dbPath = join(cfg.dataDir, 'pageask.db');
const old = new DatabaseSync(dbPath);
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

// Import after creating the old file: db.mjs migrates at import time.
const db = await import(`../server/db.mjs?migration=${Date.now()}`);
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
