// Process lifecycle: on startup, decide whether the last run exited cleanly, and leave a heartbeat marker.
//
// Simpler than a PID file: a clean exit deletes data/run.json; a crash, a forced kill
// or a power cut leaves it, so next start knows shutdown was skipped. The 30s heartbeat
// separates "just crashed" from a stale marker, and reports a live second instance
// clearly instead of letting both fight over the same database.
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './db.mjs';
import { logEvent } from './log.mjs';

const markerFile = join(dataDir, 'run.json');
const HEARTBEAT_MS = 30_000;
// no heartbeat for this long means the old process is gone (the PID may have been reused)
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

/** is the process still there; EPERM means it exists but we may not signal it */
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
  // atomic replace: a half-written JSON would be read as a corrupt marker and falsely report an abnormal exit
  writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, markerFile);
}

/**
 * Called on startup. Returns { abnormal, previous, alreadyRunning }:
 * - abnormal=true means the last run did not go through the clean-exit path;
 * - previous is the marker that run left behind (pid/startedAt/version/heartbeat);
 * - alreadyRunning=true means another live process owns this dataDir. The caller must exit
 *   through its shutdown path (without deleting the live process's marker); this module never
 *   calls process.exit itself.
 */
export function startLifecycle(appVersion) {
  version = appVersion;
  startedAt = Date.now();
  mkdirSync(dataDir, { recursive: true });
  previous = readMarker();

  if (previous) {
    const lastHeartbeat = Number(previous.heartbeat ?? previous.startedAt ?? 0);
    const fresh = Date.now() - lastHeartbeat < STALE_MS;
    // a second instance on the same database: the port will almost certainly clash, so say it here
    if (previous.pid && previous.pid !== process.pid && pidAlive(previous.pid) && fresh) {
      logEvent('instance_already_running', { pid: previous.pid, startedAt: previous.startedAt });
      console.error(
        `[pageask] another backend instance is still running (pid ${previous.pid}, last heartbeat ${new Date(lastHeartbeat).toISOString()}); ` +
          'stop it first, or point dataDir in settings.json somewhere else',
      );
      return { abnormal: false, previous, alreadyRunning: true };
    }
    abnormal = true;
    logEvent('abnormal_exit_detected', {
      pid: previous.pid ?? null,
      startedAt: previous.startedAt ?? null,
      lastHeartbeat: lastHeartbeat || null,
      version: previous.version ?? null,
    });
    const when = lastHeartbeat ? new Date(lastHeartbeat).toISOString() : 'unknown';
    console.error(`[pageask] previous process did not exit cleanly (pid ${previous.pid ?? '?'}, last heartbeat ${when})`);
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
  return { abnormal, previous, alreadyRunning: false };
}

/** clean exit: stop the heartbeat, delete the marker */
export function markCleanExit() {
  if (timer) clearInterval(timer);
  timer = null;
  try {
    unlinkSync(markerFile);
  } catch {
    /* already gone */
  }
}

/** for /health: did this startup detect an abnormal exit last time */
export function lifecycleInfo() {
  return {
    startedAt,
    abnormalPreviousExit: abnormal,
    previousPid: previous?.pid ?? null,
    previousStartedAt: previous?.startedAt ?? null,
    previousLastHeartbeat: previous?.heartbeat ?? null,
  };
}
