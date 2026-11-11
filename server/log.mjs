/**
 * Backend log: one JSON per line, appended to pageask.log in the data directory.
 *
 * Purpose: the front end shows only a one-liner "failed"; the real debugging detail
 * (upstream status, raw error text, tool arguments) lands here and never reaches the UI.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dbFile } from './db.mjs';

export const logFile = join(dirname(dbFile), 'pageask.log');

function line(kind, data) {
  return `${JSON.stringify({ ts: new Date().toISOString(), kind, ...data })}\n`;
}

/** write one log record; never throws, since a failed write must not break a conversation */
export function logEvent(kind, data = {}) {
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    // A long-running tray would otherwise grow this file forever; keep one previous generation.
    // The size check is cheap and only triggers a rename every 5 MB.
    try {
      if (statSync(logFile).size > 5 * 1024 * 1024) renameSync(logFile, `${logFile}.1`);
    } catch {
      /* first write, or rename raced another process */
    }
    appendFileSync(logFile, line(kind, data), 'utf8');
  } catch (err) {
    console.error('[pageask] failed to write log file', err?.message ?? err);
  }
}

/** assertion-style record: flatten an Error into readable fields */
export function logError(kind, err, data = {}) {
  logEvent(kind, {
    ...data,
    status: err?.status,
    message: err?.message ?? String(err),
    stack: err?.stack,
  });
}

/**
 * Verbose diagnostics, off unless the backend is started with `--debug`. This is a logging switch, not a
 * configuration override: it never touches settings.json (baseUrl / model / key / port stay file-only).
 * Callers must not pass secrets — the API key lives in the Authorization header, never in these payloads.
 */
export const debugEnabled = process.argv.includes('--debug');

/** When --debug is on, echo a scoped record to stderr and persist it to the log file; otherwise a no-op. */
export function debugLog(scope, data = {}) {
  if (!debugEnabled) return;
  const record = { scope, ...data };
  try {
    console.error(`[pageask:debug] ${scope} ${JSON.stringify(record)}`);
  } catch {
    /* a broken stderr must not break a conversation */
  }
  logEvent('debug', record);
}
