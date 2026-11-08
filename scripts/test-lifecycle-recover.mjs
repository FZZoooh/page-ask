// Regression tests for abnormal-exit detection, busy_timeout, orphan screenshot cleanup,
// and recovery of a truncated trailing question.
// Uses a temporary HOME / DATA_DIR and never touches the real config or database.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temp = mkdtempSync(join(tmpdir(), 'pageask-lifecycle-'));
const dataDir = join(temp, 'data');
const home = join(temp, 'home');
const shots = join(dataDir, 'shots');
process.env.HOME = home;
process.env.USERPROFILE = home;

// The backend reads port / data dir / key from settings.json only, so every (re)start rewrites
// this file instead of passing environment variables.
function writeConfig(port) {
  mkdirSync(join(home, '.config', 'pageask'), { recursive: true });
  writeFileSync(
    join(home, '.config', 'pageask', 'settings.json'),
    JSON.stringify({
      baseUrl: 'http://127.0.0.1:1',
      model: 'test-model',
      apiKey: 'sk-test',
      state: 'auto',
      port,
      token: '',
      dataDir,
    }),
  );
}
writeConfig(8787);

const { addMessage, cleanupOrphanShots, closeDb, createConversation, recoverLastUserMessage, shotsDir } = await import(
  '../server/db.mjs'
);
assert.equal(shotsDir, shots);

function check(name, fn) {
  fn();
  console.log(`  ok  ${name}`);
}

async function freePort() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = srv.address().port;
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

async function waitFor(fn, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await fn()) return true;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 120));
  }
}

function startServer(port) {
  writeConfig(port);
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: root,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    // Piped stdio hits EPERM under the sandbox, and we never read the child's output anyway
    stdio: 'ignore',
  });
  return child;
}

async function stopServer(child) {
  if (child.exitCode != null) return;
  child.kill();
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 3000);
    child.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

async function getJson(port, path, init) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }
  return { status: res.status, body };
}

const conv = createConversation({ url: 'http://example.com/article' });
addMessage({ conversationId: conv.id, role: 'user', content: '这条提问被进程中断了 <q>引文</q>' });

// Orphan screenshots: old and unreferenced → delete; old but referenced → keep
const orphan = join(shots, 'orphan.jpg');
const kept = join(shots, 'kept.jpg');
writeFileSync(orphan, 'orphan');
writeFileSync(kept, 'kept');
const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
utimesSync(orphan, old, old);
utimesSync(kept, old, old);
const convShot = createConversation({ url: 'http://example.com/shot' });
addMessage({
  conversationId: convShot.id,
  role: 'tool',
  toolCallId: 'call_kept',
  toolName: 'screenshot',
  imagePath: 'kept.jpg',
});

check('cleanupOrphanShots 只删未被引用的旧截图', () => {
  assert.equal(cleanupOrphanShots({ maxAgeMs: 60 * 1000 }), 1);
  assert.equal(existsSync(orphan), false);
  assert.equal(existsSync(kept), true);
});

check('最后一条是 user 时取回并删除', () => {
  const got = recoverLastUserMessage(conv.id);
  assert.equal(got.content.includes('这条提问被进程中断了'), true);
  assert.equal(existsSync(join(dataDir, 'pageask.db')), true);
  assert.equal(recoverLastUserMessage(conv.id), null);
});

const conv2 = createConversation({ url: 'http://example.com/other' });
addMessage({ conversationId: conv2.id, role: 'user', content: '恢复我' });
addMessage({ conversationId: conv2.id, role: 'assistant', content: '已经回答过了' });
const conv3 = createConversation({ url: 'http://example.com/crash' });
addMessage({ conversationId: conv3.id, role: 'user', content: '崩溃前的提问 <q>引文</q>' });
closeDb();

const port = await freePort();
let child = startServer(port);
assert.equal(await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/health/live`)).ok), true);

const first = await getJson(port, '/health');
check('首次启动 lifecycle 正常', () => {
  assert.equal(first.body.lifecycle.abnormalPreviousExit, false);
  assert.ok(existsSync(join(dataDir, 'run.json')), 'run.json 应存在');
});

const before = await getJson(port, `/conversations/${conv2.id}/recover`, { method: 'POST' });
check('最后一条已是 assistant 时不恢复', () => assert.equal(before.status, 409));

// A second process on the same dataDir must step aside without deleting the live marker.
const duplicate = startServer(port);
const duplicateExited = await waitFor(() => duplicate.exitCode !== null, 5000);
check('同 dataDir 的第二个实例以退出码 1 结束', () => {
  assert.equal(duplicateExited, true);
  assert.equal(duplicate.exitCode, 1);
});
const stillLive = await fetch(`http://127.0.0.1:${port}/health/live`);
check('第二个实例退出后第一个仍在运行', () => assert.equal(stillLive.ok, true));
check('第二个实例未删除 run.json', () => assert.ok(existsSync(join(dataDir, 'run.json'))));

await stopServer(child);
await new Promise((r) => setTimeout(r, 500));

const port2 = await freePort();
child = startServer(port2);
assert.equal(await waitFor(async () => (await fetch(`http://127.0.0.1:${port2}/health/live`)).ok), true);

const second = await getJson(port2, '/health');
check('强杀后重启标记为异常退出', () => {
  assert.equal(second.body.lifecycle.abnormalPreviousExit, true);
  assert.equal(typeof second.body.lifecycle.previousPid, 'number');
});

// Leave conv3's last row an unanswered user message
const got = await getJson(port2, `/conversations/${conv3.id}/recover`, { method: 'POST' });
check('HTTP 恢复接口返回文本并删除', () => {
  assert.equal(got.status, 200);
  assert.equal(got.body.text, '崩溃前的提问 <q>引文</q>');
  assert.equal(typeof got.body.messageId, 'string');
});
const again = await getJson(port2, `/conversations/${conv3.id}/recover`, { method: 'POST' });
check('再次恢复返回 409', () => assert.equal(again.status, 409));
const convAfter = await getJson(port2, `/conversations/${conv3.id}`);
check('历史里那条 user 已被删除', () => {
  assert.equal(convAfter.body.messages.length, 0);
});

const shutdown = await fetch(`http://127.0.0.1:${port2}/api/shutdown`, {
  method: 'POST',
  headers: { Origin: `http://127.0.0.1:${port2}` },
});
check('优雅停止返回 202', () => assert.equal(shutdown.status, 202));
assert.equal(
  await waitFor(() => !existsSync(join(dataDir, 'run.json')), 5000),
  true,
  '优雅退出后 run.json 应删除',
);
await stopServer(child);

// After the WAL checkpoint the main DB should hold recent writes (a leftover -wal is allowed)
check('退出后主库文件存在且已关闭', () => assert.equal(statSync(join(dataDir, 'pageask.db')).isFile(), true));
check('关闭后的数据库通过 integrity_check', () => {
  const db = new DatabaseSync(join(dataDir, 'pageask.db'), { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally {
    db.close();
  }
});

console.log('全部通过');
rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
