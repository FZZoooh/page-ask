// Checks the persistence and replay constraints of "one turn = assistant + all its tool rows".
// Uses a temporary HOME (whose settings.json points at a temporary data dir) and never touches the
// real conversations in server/data.
//
// Run: node scripts/test-turn-integrity.mjs
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { makeTestConfig } from './temp-config.mjs';

// server/db.mjs resolves the data dir from settings.json at import time, and there are no env
// vars anymore: makeTestConfig writes a throw-away home first, so it must run before the import.
const { cleanup, dataDir } = makeTestConfig({ port: 8787 });

const { addTurn, closeDb, createConversation, getConversation, historyItems } = await import('../server/db.mjs');

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

try {
  // 1) Normal tool turn: every call on the assistant has a matching tool row
  const conv = createConversation({ url: 'https://example.com/a', title: 'turn' });
  addTurn({
    conversationId: conv.id,
    assistant: {
      content: '',
      reasoning: '想想',
      toolCalls: [
        { id: 'call_a', name: 'read_page', arguments: '{"scope":"page"}' },
        { id: 'call_b', name: 'read_page', arguments: '{"scope":"viewport"}' },
      ],
      responseId: 'resp_a',
    },
    tools: [
      { content: 'A', toolCallId: 'call_a', toolName: 'read_page' },
      { content: 'B', toolCallId: 'call_b', toolName: 'read_page' },
    ],
  });
  check('complete round: 2 calls + 2 outputs', () => {
    const items = historyItems(conv.id);
    assert.equal(items.filter((i) => i.type === 'function_call').length, 2);
    assert.equal(items.filter((i) => i.type === 'function_call_output').length, 2);
    const calls = items.filter((i) => i.type === 'function_call').map((i) => i.call_id).sort();
    const outs = items.filter((i) => i.type === 'function_call_output').map((i) => i.call_id).sort();
    assert.deepEqual(calls, outs);
  });

  check('reasoning replay: text preserved and placed before the function_call', () => {
    const items = historyItems(conv.id);
    const reasoning = items.find((item) => item.type === 'reasoning');
    assert.ok(reasoning, 'historyItems must include the reasoning item');
    assert.equal(reasoning.content?.[0]?.text, '想想');
    assert.ok(!('encrypted_content' in reasoning), 'encrypted_content must not be replayed');
    assert.ok(Array.isArray(reasoning.summary) && reasoning.summary.length === 0, 'summary may only be an empty placeholder');
    const reasoningIndex = items.indexOf(reasoning);
    const firstCallIndex = items.findIndex((item) => item.type === 'function_call');
    assert.ok(reasoningIndex >= 0 && firstCallIndex > reasoningIndex, 'reasoning must precede the function_call');
  });

  check('addTurn writes in one transaction: assistant and tool rowids are consecutive', () => {
    const convDb = getConversation(conv.id);
    assert.ok(convDb && convDb.messages.length === 3);
    assert.equal(convDb.messages[0].role, 'assistant');
    assert.equal(convDb.messages[1].role, 'tool');
    assert.equal(convDb.messages[2].role, 'tool');
    // Role counts alone would pass even if a concurrent writer slipped a row into the middle.
    const db = new DatabaseSync(join(dataDir, 'righthandman.db'), { readOnly: true });
    try {
      const rows = db
        .prepare('SELECT rowid, role FROM messages WHERE conversation_id = ? ORDER BY rowid')
        .all(conv.id);
      assert.deepEqual(rows.map((r) => r.role), ['assistant', 'tool', 'tool']);
      assert.equal(rows[1].rowid, rows[0].rowid + 1);
      assert.equal(rows[2].rowid, rows[1].rowid + 1);
    } finally {
      db.close();
    }
  });

  // 2) Legacy data: the assistant has 2 calls but only 1 tool row was persisted.
  //    Replay must not send the second call (upstream would 400), yet the existing one must survive.
  const legacy = createConversation({ url: 'https://example.com/b', title: 'legacy' });
  addTurn({
    conversationId: legacy.id,
    assistant: {
      toolCalls: [
        { id: 'call_c', name: 'read_page', arguments: '{}' },
        { id: 'call_d', name: 'read_page', arguments: '{}' },
      ],
    },
    tools: [{ content: 'C', toolCallId: 'call_c', toolName: 'read_page' }],
  });
  check('dangling call replay: only calls with output are sent', () => {
    const items = historyItems(legacy.id);
    assert.deepEqual(
      items.filter((i) => i.type === 'function_call').map((i) => i.call_id),
      ['call_c'],
    );
    assert.equal(items.filter((i) => i.type === 'function_call_output').length, 1);
  });

  // 3) The abort flag persists (the front end uses it to show "stopped")
  const stopped = createConversation({ url: 'https://example.com/c', title: 'stopped' });
  addTurn({
    conversationId: stopped.id,
    assistant: { content: '半截回答', aborted: true },
  });
  check('the aborted flag is stored', () => {
    const convDb = getConversation(stopped.id);
    const assistant = convDb.messages.find((m) => m.role === 'assistant');
    assert.equal(assistant.content, '半截回答');
    assert.equal(assistant.aborted, true);
  });
} finally {
  try {
    closeDb();
  } catch {
    /* the db may already be closed on an early failure */
  }
  try {
    cleanup();
  } catch {
    // On Windows SQLite's -wal/-shm sometimes still hold a handle; leave them to temp cleanup
  }
}

if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log('\nall good');
