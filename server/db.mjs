// Persistence layer for the local PageAsk backend: one SQLite file plus a few fixed queries.
// Uses the built-in node:sqlite (Node >= 22.5; verified on 24.18 with no flag needed).
//
// Since P3 the messages table also has to store "tool calls":
//   assistant rows: tool_calls = JSON array (OpenAI format, with id/name/arguments)
//   tool      rows: tool_call_id / tool_name / tool_args, content is the text the tool returned
// Since v0.9 it also stores screenshot filenames (tool rows' image_path, files under data/shots/), read back
// when replaying history and folded into function_call_output, so "look at that image again" still works.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir } from './settings.mjs';

const DB_FILE = join(dataDir, 'pageask.db');
/** Data directory: lifecycle markers, screenshots and logs all live here (path comes from settings.json) */
export { dataDir };

mkdirSync(dirname(DB_FILE), { recursive: true });

/** Screenshot landing directory: data/shots/<uuid>.jpg */
export const shotsDir = join(dataDir, 'shots');
mkdirSync(shotsDir, { recursive: true });

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
// Stop a second process (or another instance probing liveness from the tray) from hitting
// SQLITE_BUSY on the first write: wait 5 seconds before erroring, normal concurrent writes queue up.
db.exec('PRAGMA busy_timeout = 5000');
db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id          TEXT PRIMARY KEY,
    url         TEXT NOT NULL,
    title       TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role            TEXT NOT NULL,
    content         TEXT NOT NULL DEFAULT '',
    reasoning       TEXT NOT NULL DEFAULT '',
    created_at      INTEGER NOT NULL,
    tokens_in       INTEGER,
    tokens_out      INTEGER,
    ms              INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_conv_url  ON conversations (url, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_msg_conv  ON messages (conversation_id, created_at);
`);

// P2 databases predate the tool columns; patch them in place here (SQLite ADD COLUMN is cheap)
{
  const have = new Set(db.prepare('PRAGMA table_info(messages)').all().map((r) => r.name));
  const wanted = [
    ['tool_calls', 'TEXT'],
    ['tool_call_id', 'TEXT'],
    ['tool_name', 'TEXT'],
    ['tool_args', 'TEXT'],
    ['aborted', 'INTEGER NOT NULL DEFAULT 0'],
    ['tool_failed', 'INTEGER'],
    ['image_path', 'TEXT'],
    ['process_ms', 'INTEGER'],
    ['response_id', 'TEXT'],
  ];
  for (const [name, ddl] of wanted) {
    if (!have.has(name)) db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${ddl}`);
  }
}

const now = () => Date.now();

export const dbFile = DB_FILE;

/* ---------------- conversations ---------------- */

export function listConversations(url) {
  const rows = db
    .prepare(
      `SELECT c.id, c.url, c.title, c.created_at, c.updated_at,
              -- Count rounds by user questions: tool calls add assistant segments, so user+assistant would overcount
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user') AS message_count,
              (SELECT MAX(m.created_at) FROM messages m WHERE m.conversation_id = c.id) AS last_message_at,
              (SELECT m.content FROM messages m
                WHERE m.conversation_id = c.id AND m.role = 'user'
                ORDER BY m.created_at DESC LIMIT 1) AS last_user_text
         FROM conversations c
        WHERE c.url = ?
        ORDER BY COALESCE(last_message_at, c.updated_at) DESC`,
    )
    .all(url);
  return rows.map(toConversation);
}

/**
 * Load a conversation. Without `limit` the whole history is returned (tests and internal callers);
 * with `limit` only the newest page is loaded, and `nextBefore` is the id to pass as `before` for the page
 * before it. Pagination is rowid-based: created_at can collide when a turn writes several rows at once.
 */
export function getConversation(id, { limit = null, before = null } = {}) {
  const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  if (!row) return null;

  let rows;
  let hasMore = false;
  if (limit == null) {
    rows = db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(id);
  } else {
    const pageSize = Math.max(1, Math.min(500, Math.trunc(Number(limit)) || 200));
    const params = [id];
    const where = ['conversation_id = ?'];
    if (before) {
      // An unknown/stale cursor must not fall back to the first page: that would loop forever in the UI.
      const anchor = db
        .prepare('SELECT rowid FROM messages WHERE id = ? AND conversation_id = ?')
        .get(before, id);
      where.push('rowid < ?');
      params.push(anchor?.rowid ?? 0);
    }
    params.push(pageSize + 1);
    rows = db
      .prepare(`SELECT rowid, * FROM messages WHERE ${where.join(' AND ')} ORDER BY rowid DESC LIMIT ?`)
      .all(...params);
    hasMore = rows.length > pageSize;
    if (hasMore) rows = rows.slice(0, pageSize);
    rows.reverse();
  }

  const messages = rows.map(toMessage);
  return {
    ...toConversation(row),
    messages,
    hasMore,
    nextBefore: hasMore ? (messages[0]?.id ?? null) : null,
  };
}

export function createConversation({ url, title = '' }) {
  const id = randomUUID();
  const ts = now();
  db.prepare('INSERT INTO conversations (id, url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
    id,
    url,
    title,
    ts,
    ts,
  );
  return { id, url, title, createdAt: ts, updatedAt: ts, messages: [] };
}

export function deleteConversation(id) {
  return db.prepare('DELETE FROM conversations WHERE id = ?').run(id).changes > 0;
}

export function touchConversation(id, { title } = {}) {
  const ts = now();
  if (title) {
    db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?').run(title, ts, id);
  } else {
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(ts, id);
  }
}

/* ---------------- messages ---------------- */

export function addMessage({
  conversationId,
  role,
  content = '',
  reasoning = '',
  toolCalls = null,
  toolCallId = null,
  toolName = null,
  toolArgs = null,
  toolFailed = null,
  imagePath = null,
  tokensIn = null,
  tokensOut = null,
  ms = null,
  processMs = null,
  responseId = null,
  aborted = false,
}) {
  const id = randomUUID();
  const ts = now();
  // Use SAVEPOINT rather than BEGIN: addTurn already holds a transaction and this has to nest inside it;
  // called on its own it is a complete transaction, so the INSERT and touch can't half-apply.
  db.exec('SAVEPOINT add_message');
  try {
    db.prepare(
      `INSERT INTO messages
         (id, conversation_id, role, content, reasoning, created_at,
          tokens_in, tokens_out, ms, process_ms, tool_calls, tool_call_id, tool_name, tool_args,
          aborted, tool_failed, image_path, response_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      conversationId,
      role,
      content,
      reasoning,
      ts,
      tokensIn,
      tokensOut,
      ms,
      processMs,
      toolCalls ? JSON.stringify(toolCalls) : null,
      toolCallId,
      toolName,
      toolArgs ? JSON.stringify(toolArgs) : null,
      aborted ? 1 : 0,
      toolFailed == null ? null : toolFailed ? 1 : 0,
      imagePath,
      responseId,
    );
    touchConversation(conversationId);
    db.exec('RELEASE add_message');
  } catch (err) {
    try {
      db.exec('ROLLBACK TO add_message');
      db.exec('RELEASE add_message');
    } catch {
      // the transaction may already have been rolled back by the outer scope; keep the original error
    }
    throw err;
  }
  return toMessage({
    id,
    conversation_id: conversationId,
    role,
    content,
    reasoning,
    created_at: ts,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    ms,
    process_ms: processMs,
    tool_calls: toolCalls ? JSON.stringify(toolCalls) : null,
    tool_call_id: toolCallId,
    tool_name: toolName,
    tool_args: toolArgs ? JSON.stringify(toolArgs) : null,
    aborted: aborted ? 1 : 0,
    tool_failed: toolFailed == null ? null : toolFailed ? 1 : 0,
    image_path: imagePath,
    response_id: responseId,
  });
}

/**
 * Writes one turn (assistant + the tool rows it spawned) in a single shot.
 * When the tool loop is aborted halfway, the caller fills every unexecuted call with placeholder output;
 * this guarantees those rows are either all present or all absent — history never ends up
 * with a dangling "function_call without function_call_output" pair.
 */
export function addTurn({ conversationId, assistant, tools = [] }) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const savedAssistant = addMessage({ conversationId, role: 'assistant', ...assistant });
    const savedTools = tools.map((tool) => addMessage({ conversationId, role: 'tool', ...tool }));
    db.exec('COMMIT');
    return { assistant: savedAssistant, tools: savedTools };
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // the transaction may already have rolled back on the underlying error; don't let ROLLBACK mask it
    }
    throw err;
  }
}

/**
 * For "regenerate": delete every row after the last user message (assistant / tool),
 * keeping that user message itself. Returns the retained user row (null if there is none).
 */
export function truncateAfterLastUser(conversationId) {
  const last = db
    .prepare(
      "SELECT rowid, id FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY created_at DESC, rowid DESC LIMIT 1",
    )
    .get(conversationId);
  if (!last) return null;

  let doomed = [];
  // Read the boundary and delete inside one IMMEDIATE transaction. The previous version read the
  // boundary before BEGIN, so a concurrent writer could insert rows that the DELETE then removed.
  // The backend is single-process and /chat is serialized per conversation, so this is mostly a
  // correctness guarantee for future multi-process use rather than a live race.
  db.exec('BEGIN IMMEDIATE');
  try {
    doomed = db
      .prepare(
        'SELECT image_path FROM messages WHERE conversation_id = ? AND rowid > ? AND image_path IS NOT NULL',
      )
      .all(conversationId, last.rowid);
    const boundary = db
      .prepare('SELECT COALESCE(MAX(rowid), 0) AS maxRowid FROM messages WHERE conversation_id = ?')
      .get(conversationId).maxRowid;
    db.prepare('DELETE FROM messages WHERE conversation_id = ? AND rowid > ? AND rowid <= ?').run(
      conversationId,
      last.rowid,
      boundary,
    );
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  }

  // Regenerating discards the old answer: delete screenshots no row references anymore, so no orphan files.
  pruneShots(doomed.map((row) => row.image_path));
  return { id: last.id };
}

/**
 * For inline editing: replace one user message's text and delete every row after it, so the caller
 * can regenerate the turn from that point. The message keeps its id and created_at (the turn stays
 * where it was); later assistant/tool rows are discarded exactly like "regenerate".
 * Returns `{ id }`, or null when the id is not a user message of this conversation.
 */
export function editUserMessage({ conversationId, messageId, content }) {
  let doomed = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db
      .prepare("SELECT rowid FROM messages WHERE id = ? AND conversation_id = ? AND role = 'user'")
      .get(messageId, conversationId);
    if (!row) {
      db.exec('COMMIT');
      return null;
    }
    db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(content, messageId);
    // Read the doomed screenshots and the boundary inside the same transaction as the DELETE.
    doomed = db
      .prepare(
        'SELECT image_path FROM messages WHERE conversation_id = ? AND rowid > ? AND image_path IS NOT NULL',
      )
      .all(conversationId, row.rowid);
    const boundary = db
      .prepare('SELECT COALESCE(MAX(rowid), 0) AS maxRowid FROM messages WHERE conversation_id = ?')
      .get(conversationId).maxRowid;
    db.prepare('DELETE FROM messages WHERE conversation_id = ? AND rowid > ? AND rowid <= ?').run(
      conversationId,
      row.rowid,
      boundary,
    );
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  }

  pruneShots(doomed.map((row) => row.image_path));
  return { id: messageId };
}

/** Delete a set of screenshot files, but only ones no message references (content-addressed, rows may share) */
export function pruneShots(paths) {
  for (const path of paths) {
    if (!path) continue;
    const stillUsed = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE image_path = ?').get(path).n;
    if (stillUsed > 0) continue;
    try {
      unlinkSync(join(shotsDir, path));
    } catch {
      /* the file may be gone already */
    }
  }
}

/**
 * A mid-process exit leaves behind conversations whose last row is a user message with no assistant answer.
 * When the side panel reads such a conversation it takes that question back into the composer and
 * deletes it from the DB, so resending won't produce two identical questions. Only the last row is
 * deleted, and only if it is a user row, so content that already got an answer is never lost.
 */
export function recoverLastUserMessage(conversationId) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const last = db
      .prepare(
        'SELECT id, role, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
      )
      .get(conversationId);
    if (!last || last.role !== 'user') {
      db.exec('COMMIT');
      return null;
    }
    db.prepare('DELETE FROM messages WHERE id = ?').run(last.id);
    db.exec('COMMIT');
    return { id: last.id, content: last.content ?? '' };
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* the transaction may have rolled back on its own; don't mask the original error */
    }
    throw err;
  }
}

export function historyItems(conversationId) {
  const rows = db
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC')
    .all(conversationId);
  return rowsToItems(rows);
}

/**
 * For stateful mode: find the "chain anchor" — the last assistant message carrying a response_id.
 * Returns its rowid and response id; null if absent (first turn, or a conversation that only ran stateless).
 */
export function lastResponseAnchor(conversationId) {
  const row = db
    .prepare(
      `SELECT rowid, response_id FROM messages
       WHERE conversation_id = ? AND role = 'assistant' AND response_id IS NOT NULL
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(conversationId);
  if (!row) return null;
  return { rowid: row.rowid, responseId: row.response_id };
}

/**
 * For stateful mode: take only the rows after the anchor and turn them into input.
 * Everything before the anchor is already stored upstream (previous_response_id), so it isn't resent.
 */
export function historyItemsSince(conversationId, anchorRowid) {
  const rows = db
    .prepare(
      `SELECT * FROM messages WHERE conversation_id = ? AND rowid > ?
       ORDER BY created_at ASC, rowid ASC`,
    )
    .all(conversationId, anchorRowid);
  return rowsToItems(rows);
}

/**
 * Row → Responses API input items (shared by stateless full replay and stateful tail-only sends)
 * - user message → {role:'user', content:[{type:'input_text'}]}
 * - that turn's reasoning → {type:'reasoning', content:[{type:'reasoning_text'}]} (before the turn's output)
 * - assistant body → {role:'assistant', content:[{type:'output_text'}]}
 * - that turn's tool_calls → one {type:'function_call', call_id, name, arguments} each
 * - tool row → {type:'function_call_output', call_id, output}; the image rides along if there is a screenshot
 *
 * Reasoning replay is required, not optional: every /chat request carries `tools`, and DeepSeek thinking
 * mode requires all historical reasoning content to be returned whenever `tools` is present — even for
 * turns where the model made no tool call; omitting it returns 400. Tool-less requests (auto-title) do not
 * use this function. The `id` is a local placeholder and `summary: []` is only an empty schema field for
 * OpenAI compatibility; never put a real summary or encrypted_content here.
 */
function rowsToItems(rows) {
  const out = [];
  // Stateless replay resends the entire history, and every screenshot is base64. Keep only the newest few
  // images under a total character budget; older tool outputs stay text-only so one long chat can't blow
  // up the request body (and the context window) with every past viewport.
  const REPLAY_IMAGE_MAX_COUNT = 8;
  const REPLAY_IMAGE_MAX_CHARS = 6_000_000;
  const replayImages = new Map();
  let imageChars = 0;
  for (let i = rows.length - 1; i >= 0 && replayImages.size < REPLAY_IMAGE_MAX_COUNT; i--) {
    const r = rows[i];
    if (r.role !== 'tool' || !r.image_path) continue;
    const image = shotToDataUrl(r.image_path);
    if (!image) continue;
    if (imageChars + image.length > REPLAY_IMAGE_MAX_CHARS) continue;
    replayImages.set(r.id, image);
    imageChars += image.length;
  }
  // History may still hold dangling calls from older versions (old logic wrote the assistant row, then
  // each tool row). On replay keep only calls that have a real tool row: one missing record beats a 400.
  const answeredCalls = new Set();
  for (const r of rows) {
    if (r.role === 'tool' && r.tool_call_id) answeredCalls.add(r.tool_call_id);
  }
  for (const r of rows) {
    if (r.role === 'tool') {
      if (!r.tool_call_id) continue;
      const image = replayImages.get(r.id);
      out.push({
        type: 'function_call_output',
        call_id: r.tool_call_id,
        output: image
          ? [
              { type: 'input_text', text: r.content ?? '' },
              { type: 'input_image', image_url: image, detail: 'high' },
            ]
          : (r.content ?? ''),
      });
      continue;
    }
    if (r.role === 'assistant') {
      if (r.reasoning && r.reasoning.trim()) {
        out.push({
          type: 'reasoning',
          id: `rs_${r.id}`,
          status: 'completed',
          content: [{ type: 'reasoning_text', text: r.reasoning }],
          summary: [],
        });
      }
      if (r.content && r.content.trim()) {
        out.push({ role: 'assistant', content: [{ type: 'output_text', text: r.content }] });
      }
      const calls = safeJson(r.tool_calls);
      if (Array.isArray(calls)) {
        for (const call of calls) {
          if (!call || typeof call !== 'object') continue;
          const name = call.name ?? call.function?.name;
          const args = call.arguments ?? call.function?.arguments ?? '{}';
          if (!name || !call.id) continue;
          if (!answeredCalls.has(call.id)) continue;
          out.push({ type: 'function_call', call_id: call.id, name, arguments: args });
        }
      }
      continue;
    }
    if (!r.content) continue;
    out.push({ role: r.role, content: [{ type: 'input_text', text: r.content }] });
  }
  return out;
}

/** Every screenshot filename this conversation uses (for clearing files when it is deleted) */
export function imagePathsFor(conversationId) {
  return db
    .prepare('SELECT image_path FROM messages WHERE conversation_id = ? AND image_path IS NOT NULL')
    .all(conversationId)
    .map((r) => r.image_path);
}

/** Screenshot filename → data URL; null if the file is gone (history just misses an image, that must not throw) */
const shotCache = new Map();
// A screenshot is a base64 data URL, often a few hundred KB. The cache keeps only the most recently
// used few: unbounded, a long conversation would pin every past screenshot in memory, never released.
const SHOT_CACHE_MAX = 16;

function imageMime(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return 'image/jpeg';
}

function shotToDataUrl(name) {
  if (!name) return null;
  if (shotCache.has(name)) {
    // LRU: move to the tail on a hit
    const hit = shotCache.get(name);
    shotCache.delete(name);
    shotCache.set(name, hit);
    return hit;
  }
  let url = null;
  try {
    const buf = readFileSync(join(shotsDir, name));
    url = `data:${imageMime(buf)};base64,${buf.toString('base64')}`;
  } catch {
    url = null;
  }
  // Do not cache a miss: a screenshot restored from backup (or a file created a moment later)
  // must become visible without restarting the backend.
  if (url) {
    shotCache.set(name, url);
    if (shotCache.size > SHOT_CACHE_MAX) {
      const oldest = shotCache.keys().next().value;
      if (oldest !== undefined) shotCache.delete(oldest);
    }
  }
  return url;
}

/**
 * Keep the referenced screenshots under a total byte budget. Images are replayed into future
 * requests, so old ones eventually cost more than they are worth; drop the oldest rows' image_path
 * (the text stays) and their files. Returns the number of dropped files.
 */
export function trimShotBudget({ maxBytes = 512 * 1024 * 1024 } = {}) {
  const rows = db
    .prepare('SELECT id, image_path FROM messages WHERE image_path IS NOT NULL ORDER BY rowid DESC')
    .all();
  let total = 0;
  let dropped = 0;
  const kept = new Set();
  const removed = new Set();
  for (const row of rows) {
    const full = join(shotsDir, row.image_path);
    // Screenshots are content-addressed, so several rows may share one file. Count it once and
    // only unlink it after the last referencing row has been trimmed.
    if (kept.has(row.image_path)) continue;
    if (removed.has(row.image_path)) {
      db.prepare('UPDATE messages SET image_path = NULL WHERE id = ?').run(row.id);
      dropped++;
      continue;
    }
    let size = 0;
    try {
      size = statSync(full).size;
    } catch {
      size = 0;
    }
    if (total + size <= maxBytes) {
      total += size;
      kept.add(row.image_path);
      continue;
    }
    db.prepare('UPDATE messages SET image_path = NULL WHERE id = ?').run(row.id);
    removed.add(row.image_path);
    dropped++;
    const still = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE image_path = ?').get(row.image_path);
    if (still.n > 0) continue;
    try {
      unlinkSync(full);
    } catch {
      /* already gone */
    }
  }
  return dropped;
}

/**
 * On startup, delete screenshots no message references, plus half-written `.tmp-*` files a crash left behind.
 * Only files older than 1 hour: another instance / an in-flight turn may have written one, not yet in the DB.
 */
export function cleanupOrphanShots({ maxAgeMs = 60 * 60 * 1000 } = {}) {
  const referenced = new Set(
    db
      .prepare('SELECT image_path FROM messages WHERE image_path IS NOT NULL')
      .all()
      .map((r) => r.image_path),
  );
  let removed = 0;
  let names = [];
  try {
    names = readdirSync(shotsDir);
  } catch {
    return 0;
  }
  const now = Date.now();
  for (const name of names) {
    const full = join(shotsDir, name);
    try {
      const st = statSync(full);
      if (!st.isFile() || now - st.mtimeMs < maxAgeMs) continue;
      if (referenced.has(name)) continue;
      unlinkSync(full);
      removed++;
    } catch {
      /* the file may have just been deleted by another process; skip it */
    }
  }
  return removed;
}

/** Close the DB before a normal exit: let SQLite checkpoint once instead of leaving recent data in -wal */
export function closeDb() {
  try {
    db.close();
  } catch {
    /* already closed, or a statement is still running; not worth throwing during shutdown */
  }
}

/** How many user/assistant turns a conversation has (auto-title only needs the pair count) */
export function statsFor(conversationId) {
  const count = (role) =>
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND role = ? AND TRIM(content) <> ''",
      )
      .get(conversationId, role).n;
  return {
    users: count('user'),
    answers: count('assistant'),
  };
}

/* ---------------- rows → objects ---------------- */

function toConversation(row) {
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Timestamp of the last message; the list displays and sorts by it (in old DBs updated_at was
    // only bumped on creation/title generation, so using it directly degenerates to "creation time")
    lastMessageAt: row.last_message_at ?? undefined,
    messageCount: row.message_count ?? undefined,
    lastUserText: row.last_user_text ?? undefined,
  };
}

function toMessage(row) {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    reasoning: row.reasoning,
    createdAt: row.created_at,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    ms: row.ms,
    processMs: row.process_ms ?? null,
    // Upstream response id for this reply (stateful mode uses it as the previous_response_id anchor)
    responseId: row.response_id ?? null,
    toolCalls: safeJson(row.tool_calls),
    toolCallId: row.tool_call_id ?? null,
    toolName: row.tool_name ?? null,
    toolArgs: safeJson(row.tool_args),
    toolFailed: row.tool_failed == null ? null : Boolean(row.tool_failed),
    imagePath: row.image_path ?? null,
    aborted: Boolean(row.aborted),
  };
}

function safeJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
