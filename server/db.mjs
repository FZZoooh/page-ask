// PageAsk 本地后端的持久化层：一个 SQLite 文件 + 几条固定查询。
// 用 Node 内置 node:sqlite（Node >= 22.5，实测 24.18 无需 flag）。
//
// 从 P3 起，messages 表还要能存「工具调用」：
//   assistant 行：tool_calls = JSON 数组（OpenAI 格式，含 id/name/arguments）
//   tool      行：tool_call_id / tool_name / tool_args，content 是工具返回的文本
// 从 v0.9 起还存截图文件名（tool 行的 image_path，文件落在 data/shots/ 下），
// 回放历史时重新读出来塞进 function_call_output，这样「回头再看那张图」也能看。
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const DATA_DIR = resolve(process.env.PAGEASK_DATA_DIR ?? join(import.meta.dirname, 'data'));
const DB_FILE = join(DATA_DIR, 'pageask.db');
/** data 目录：生命周期标记、截图、日志都放这里 */
export const dataDir = DATA_DIR;

mkdirSync(dirname(DB_FILE), { recursive: true });

/** 截图落盘目录：data/shots/<uuid>.jpg */
export const shotsDir = join(DATA_DIR, 'shots');
mkdirSync(shotsDir, { recursive: true });

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
// 别再让第二个进程（或托盘探活时的另一个实例）一写就撞 SQLITE_BUSY：
// 等 5 秒再报错，正常的并发写会自己排上队。
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

// P2 的老库没有工具相关列，这里就地补齐（SQLite 的 ADD COLUMN 是廉价的）
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

/* ---------------- 会话 ---------------- */

export function listConversations(url) {
  const rows = db
    .prepare(
      `SELECT c.id, c.url, c.title, c.created_at, c.updated_at,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.role IN ('user','assistant')) AS message_count,
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

export function getConversation(id) {
  const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  if (!row) return null;
  return {
    ...toConversation(row),
    messages: db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(id)
      .map(toMessage),
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

/* ---------------- 消息 ---------------- */

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
  // 用 SAVEPOINT 而不是 BEGIN：addTurn 已经开了事务，这里必须能嵌进去；
  // 单独调用时它自己就是一次完整事务，INSERT 与 touch 不会只成一半。
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
      // 事务可能已经被外层回滚，保留原始错误
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
 * 一轮（assistant + 它引发的 tool 行）一次性写入。
 * 工具执行到一半被中止时，调用方会把未执行的 call 补成占位 output；
 * 这里保证这些行要么全在、要么全不在 —— 历史里不会出现
 * “有 function_call、没有 function_call_output”的悬空对。
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
      // 事务可能已经因底层错误回滚了，别让 ROLLBACK 覆盖真正的错误
    }
    throw err;
  }
}

/**
 * 「重新生成」用：删掉最后一条 user 消息之后的所有行（assistant / tool），
 * 保留那条 user 消息本身。返回被保留的 user 行（没有就返回 null）。
 */
export function truncateAfterLastUser(conversationId) {
  const last = db
    .prepare(
      "SELECT rowid, id FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY created_at DESC, rowid DESC LIMIT 1",
    )
    .get(conversationId);
  if (!last) return null;

  const doomed = db
    .prepare(
      'SELECT image_path FROM messages WHERE conversation_id = ? AND rowid > ? AND image_path IS NOT NULL',
    )
    .all(conversationId, last.rowid);

  // 只删「调用发生前已经存在」的行：另一个侧栏在两次查询之间插入的新行
  // （rowid 更大且超过 boundary）必须留下，否则双面板同时重生成会误删对方刚写的内容。
  const boundary = db
    .prepare('SELECT COALESCE(MAX(rowid), 0) AS maxRowid FROM messages WHERE conversation_id = ?')
    .get(conversationId).maxRowid;

  db.exec('BEGIN IMMEDIATE');
  try {
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

  // 重新生成会丢掉旧回答：把只被这些行引用的截图一并删掉，别留孤儿文件
  for (const row of doomed) {
    try {
      unlinkSync(join(shotsDir, row.image_path));
    } catch {
      /* 文件可能已不在 */
    }
  }
  return { id: last.id };
}

/**
 * 进程中途退出会留下「最后一条是 user、没有 assistant 回答」的会话。
 * 侧栏读到这种会话时把这句提问取回输入框，并从库里删掉：
 * 用户重发后不会出现两条一样的提问。只删最后一行，且必须是 user，
 * 避免误删已经得到回答的内容。
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
      /* 事务可能已自己回滚，别覆盖原始错误 */
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
 * 有状态模式用：找出「链锚点」——最后一条带 response_id 的 assistant 消息。
 * 返回它的 rowid 与 response id；没有就返回 null（第一轮，或一直是纯无状态跑下来的老会话）。
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
 * 有状态模式用：只取锚点之后的行转成 input。
 * 锚点之前的内容上游已经存下来了（previous_response_id），不用再发一遍。
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
 * 行 → Responses API 的 input items（无状态全量、有状态只发尾部，两处共用）
 * - 用户消息 → {role:'user', content:[{type:'input_text'}]}
 * - 助手那轮的思考 → {type:'reasoning', content:[{type:'reasoning_text'}]}（放在该轮输出之前）
 * - 助手正文 → {role:'assistant', content:[{type:'output_text'}]}
 * - 助手那轮的 tool_calls → 逐条 {type:'function_call', call_id, name, arguments}
 * - tool 行 → {type:'function_call_output', call_id, output}；有截图就把图片一起带上
 * reasoning item 不传虽然也不报错，但传回去效果更好（用户实测反馈），所以照样重发。
 */
function rowsToItems(rows) {
  const out = [];
  // 历史里可能残留旧版本写下的悬空 call（旧逻辑先写 assistant、再逐个写 tool）。
  // 回放时只保留确实有 tool 行的 call：宁可少一条调用记录，也不要让上游 400。
  const answeredCalls = new Set();
  for (const r of rows) {
    if (r.role === 'tool' && r.tool_call_id) answeredCalls.add(r.tool_call_id);
  }
  for (const r of rows) {
    if (r.role === 'tool') {
      if (!r.tool_call_id) continue;
      const image = shotToDataUrl(r.image_path);
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

/** 该会话用到的所有截图文件名（删会话时用来清文件） */
export function imagePathsFor(conversationId) {
  return db
    .prepare('SELECT image_path FROM messages WHERE conversation_id = ? AND image_path IS NOT NULL')
    .all(conversationId)
    .map((r) => r.image_path);
}

/** 截图文件名 → data URL；文件不在就返回 null（历史里只是少张图，不该报错） */
const shotCache = new Map();
// 截图是 base64 data URL，单条可能有几百 KB。缓存只保留最近用到的若干张：
// 不设上限时长会话会把每条历史截图都钉在内存里，删会话也不会释放。
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
    // LRU：命中后挪到队尾
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
  shotCache.set(name, url);
  if (shotCache.size > SHOT_CACHE_MAX) {
    const oldest = shotCache.keys().next().value;
    if (oldest !== undefined) shotCache.delete(oldest);
  }
  return url;
}

/**
 * 启动时清掉没有被任何消息引用的截图，以及崩溃留下的半截 `.tmp-*` 文件。
 * 只删超过 1 小时的文件：另一个实例/正在进行的一轮可能刚写盘还没来得及落库。
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
      /* 文件可能刚被别的进程删掉，跳过 */
    }
  }
  return removed;
}

/** 正常退出前关库：让 SQLite 做一次 checkpoint，别把最近的数据全留在 -wal 里 */
export function closeDb() {
  try {
    db.close();
  } catch {
    /* 已经关了或还有语句在跑，退出流程里不值得再抛 */
  }
}

/** 会话里问了几轮、最后一句用户话和最近一条助手正文（自动标题用） */
export function statsFor(conversationId) {
  const rows = db
    .prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC')
    .all(conversationId);
  const users = [];
  const answers = [];
  for (const r of rows) {
    const text = (r.content ?? '').trim();
    if (!text) continue;
    if (r.role === 'user') users.push(text);
    else if (r.role === 'assistant') answers.push(text);
  }
  return { users: users.length, answers: answers.length, lastUser: users.at(-1) ?? '', lastAnswer: answers.at(-1) ?? '' };
}

/* ---------------- 行 → 对象 ---------------- */

function toConversation(row) {
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // 最后一条消息的时间；列表按它显示与排序（老库里 updated_at 只在建会话/生成标题时更新，
    // 直接用它的话就会退化成「对话创建时间」）
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
    // 该段回复对应的上游 response id（有状态模式用它做 previous_response_id 链锚点）
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
