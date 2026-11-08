// Regression: history is paged by rowid (created_at can collide within one turn), and stateless replay
// keeps only the newest screenshots so a long chat cannot resend every past viewport.
// Run: node scripts/test-history-page.mjs
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTestConfig } from './temp-config.mjs';

const { dataDir, cleanup } = makeTestConfig({ port: 8787 });
const { addTurn, closeDb, createConversation, getConversation, historyItems, shotsDir } = await import(
  '../server/db.mjs'
);

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
  const conv = createConversation({ url: 'https://example.com/page', title: 'page' });
  for (let i = 0; i < 5; i += 1) {
    addTurn({ conversationId: conv.id, assistant: { content: `A${i}` } });
  }

  check('no limit keeps full history', () => {
    const all = getConversation(conv.id);
    assert.equal(all.messages.length, 5);
    assert.equal(all.hasMore, false);
    assert.equal(all.nextBefore, null);
  });

  const first = getConversation(conv.id, { limit: 2 });
  check('newest page has the last two rows in ascending order', () => {
    assert.deepEqual(first.messages.map((m) => m.content), ['A3', 'A4']);
    assert.equal(first.hasMore, true);
    assert.equal(first.nextBefore, first.messages[0].id);
  });

  const second = getConversation(conv.id, { limit: 2, before: first.nextBefore });
  check('before cursor moves one page older', () => {
    assert.deepEqual(second.messages.map((m) => m.content), ['A1', 'A2']);
    assert.equal(second.hasMore, true);
    assert.equal(second.nextBefore, second.messages[0].id);
  });

  const last = getConversation(conv.id, { limit: 2, before: second.nextBefore });
  check('last page has no further cursor', () => {
    assert.deepEqual(last.messages.map((m) => m.content), ['A0']);
    assert.equal(last.hasMore, false);
    assert.equal(last.nextBefore, null);
  });

  check('unknown cursor yields an empty page, not the first page again', () => {
    const stale = getConversation(conv.id, { limit: 2, before: 'does-not-exist' });
    assert.equal(stale.messages.length, 0);
    assert.equal(stale.hasMore, false);
  });

  // Image budget: only the newest 8 screenshot tool outputs may carry an input_image.
  const withImages = createConversation({ url: 'https://example.com/img', title: 'img' });
  for (let i = 0; i < 10; i += 1) {
    const name = `shot-${i}.jpg`;
    writeFileSync(join(shotsDir, name), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    addTurn({
      conversationId: withImages.id,
      assistant: { content: '', toolCalls: [{ id: `call_${i}`, name: 'screenshot', arguments: '{}' }] },
      tools: [{ content: `tool-${i}`, toolCallId: `call_${i}`, toolName: 'screenshot', imagePath: name }],
    });
  }
  const items = historyItems(withImages.id);
  const outputs = items.filter((i) => i.type === 'function_call_output');
  const withImage = outputs.filter((o) => Array.isArray(o.output));
  check('replay keeps only the newest 8 images', () => {
    assert.equal(outputs.length, 10);
    assert.equal(withImage.length, 8);
    assert.equal(withImage[0].output[0].text, 'tool-2');
    assert.equal(withImage.at(-1).output[0].text, 'tool-9');
    assert.equal(outputs[0].output, 'tool-0');
  });
  check('test data lives in the temp dir', () => {
    assert.ok(dataDir.includes('pageask-test-'));
  });
} finally {
  closeDb();
  cleanup();
}

process.exitCode = failed ? 1 : 0;
