// 进程生命周期：启动时判断上次是不是「正常退出」，并留一个心跳标记。
//
// 做法比 PID 文件更简单：正常退出会删掉 data/run.json；崩溃、被强杀、
// 断电都会把它留下。下次启动读到它就知道上次没有走 shutdown 流程。
// 心跳每 30 秒刷新一次，用来区分「刚崩」和「很久以前留下的陈标记」，
// 也能在另一个实例还活着时给出清楚的提示，而不是让它俩抢同一个库。
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './db.mjs';
import { logEvent } from './log.mjs';

const markerFile = join(dataDir, 'run.json');
const HEARTBEAT_MS = 30_000;
// 超过这个时间没心跳，就认为旧进程已经死了（PID 可能被系统复用）
const STALE_MS = 2 * 60_000;

let timer = null;
let startedAt = Date.now();
let previous = null;
let abnormal = false;
let version = '0.0.0';

function readMarker() {
  try {
    const raw = JSON.parse(readFileSync(markerFile, 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

/** 进程还在不在；EPERM 说明进程存在但没权限发信号 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function writeMarker() {
  const body = `${JSON.stringify({
    pid: process.pid,
    startedAt,
    version,
    heartbeat: Date.now(),
  })}\n`;
  const tmp = `${markerFile}.tmp`;
  // 原子替换：半截 JSON 会被下次启动当成损坏标记，误报一次「异常退出」
  writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, markerFile);
}

/**
 * 启动时调用。返回 { abnormal, previous }：
 * - abnormal=true 表示上次没有走正常退出流程；
 * - previous 是上次留下的标记（pid/startedAt/version/heartbeat）。
 */
export function startLifecycle(appVersion) {
  version = appVersion;
  startedAt = Date.now();
  mkdirSync(dataDir, { recursive: true });
  previous = readMarker();

  if (previous) {
    const lastHeartbeat = Number(previous.heartbeat ?? previous.startedAt ?? 0);
    const fresh = Date.now() - lastHeartbeat < STALE_MS;
    // 同一个库上再起一个实例：端口大概率会冲突，先在这里说清楚
    if (previous.pid && previous.pid !== process.pid && pidAlive(previous.pid) && fresh) {
      logEvent('instance_already_running', { pid: previous.pid, startedAt: previous.startedAt });
      console.error(
        `[pageask] 另一个后端实例还在运行（pid ${previous.pid}，最后心跳 ${new Date(lastHeartbeat).toISOString()}）；` +
          '请先停掉它，或换一个 PAGEASK_DATA_DIR',
      );
      process.exit(1);
    }
    abnormal = true;
    logEvent('abnormal_exit_detected', {
      pid: previous.pid ?? null,
      startedAt: previous.startedAt ?? null,
      lastHeartbeat: lastHeartbeat || null,
      version: previous.version ?? null,
    });
    const when = lastHeartbeat ? new Date(lastHeartbeat).toISOString() : '未知时间';
    console.error(`[pageask] 检测到上次进程没有正常退出（pid ${previous.pid ?? '?'}，最后心跳 ${when}）`);
  }

  writeMarker();
  timer = setInterval(() => {
    try {
      writeMarker();
    } catch (err) {
      logEvent('lifecycle_heartbeat_failed', { message: String(err?.message ?? err) });
    }
  }, HEARTBEAT_MS);
  timer.unref?.();
  return { abnormal, previous };
}

/** 正常退出：停心跳、删标记 */
export function markCleanExit() {
  if (timer) clearInterval(timer);
  timer = null;
  try {
    unlinkSync(markerFile);
  } catch {
    /* 已经不在了 */
  }
}

/** 给 /health 用：这次启动是否检测到上次异常退出 */
export function lifecycleInfo() {
  return {
    startedAt,
    abnormalPreviousExit: abnormal,
    previousPid: previous?.pid ?? null,
    previousStartedAt: previous?.startedAt ?? null,
    previousLastHeartbeat: previous?.heartbeat ?? null,
  };
}
