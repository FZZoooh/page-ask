// 检查“一轮 = assistant + 全部 tool 行”的落库与回放约束。
// 用临时数据目录，不碰 server/data 里的真实会话。
//
// 跑法：node scripts/test-turn-integrity.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'pageask-turn-'));
process.env.PAGEASK_DATA_DIR = dataDir;

const { addTurn, createConversation, getConversation, historyItems } = await import('../server/db.mjs');

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
  // 1) 正常的工具轮次：assistant 的每个 call 都有对应 tool 行
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
  check('完整轮次：2 个 call + 2 个 output', () => {
    const items = historyItems(conv.id);
    assert.equal(items.filter((i) => i.type === 'function_call').length, 2);
    assert.equal(items.filter((i) => i.type === 'function_call_output').length, 2);
    const calls = items.filter((i) => i.type === 'function_call').map((i) => i.call_id).sort();
    const outs = items.filter((i) => i.type === 'function_call_output').map((i) => i.call_id).sort();
    assert.deepEqual(calls, outs);
  });

  check('addTurn 一次事务写入：assistant 与 tool 的 rowid 连续', () => {
    const convDb = getConversation(conv.id);
    assert.ok(convDb && convDb.messages.length === 3);
    assert.equal(convDb.messages[0].role, 'assistant');
    assert.equal(convDb.messages[1].role, 'tool');
    assert.equal(convDb.messages[2].role, 'tool');
  });

  // 2) 旧数据兼容：assistant 有 2 个 call，但只落了 1 个 tool 行。
  //    回放时不能把第 2 个 call 发出去（上游会 400），但已有的那个必须保留。
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
  check('悬空 call 回放兜底：只发有 output 的 call', () => {
    const items = historyItems(legacy.id);
    assert.deepEqual(
      items.filter((i) => i.type === 'function_call').map((i) => i.call_id),
      ['call_c'],
    );
    assert.equal(items.filter((i) => i.type === 'function_call_output').length, 1);
  });

  // 3) 中止标记能落库（前端据此显示“已停止”）
  const stopped = createConversation({ url: 'https://example.com/c', title: 'stopped' });
  addTurn({
    conversationId: stopped.id,
    assistant: { content: '半截回答', aborted: true },
  });
  check('aborted 标记落库', () => {
    const convDb = getConversation(stopped.id);
    const assistant = convDb.messages.find((m) => m.role === 'assistant');
    assert.equal(assistant.content, '半截回答');
    assert.equal(assistant.aborted, true);
  });
} finally {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows 上 SQLite 的 -wal/-shm 偶尔还占着句柄，留给系统临时目录清理
  }
}

if (failed) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log('\n全部通过');
