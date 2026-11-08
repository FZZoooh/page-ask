/**
 * Backend log: one JSON per line, appended to pageask.log in the data directory.
 *
 * Purpose: the front end shows only a one-liner "failed"; the real debugging detail
 * (upstream status, raw error text, tool arguments) lands here and never reaches the UI.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
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
