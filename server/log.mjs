/**
 * 后端日志：一行一个 JSON，追加写到数据目录下的 pageask.log。
 *
 * 用途：前端只显示「失败」这种一句话，真正的排查细节（上游状态码、
 * 原文报错、工具参数）落在这里，不进 UI。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dbFile } from './db.mjs';

export const logFile = join(dirname(dbFile), 'pageask.log');

function line(kind, data) {
  return `${JSON.stringify({ ts: new Date().toISOString(), kind, ...data })}\n`;
}

/** 写一条日志；永远不抛错，日志写不进去也不能影响对话 */
export function logEvent(kind, data = {}) {
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(logFile, line(kind, data), 'utf8');
  } catch (err) {
    console.error('[pageask] 写日志失败', err?.message ?? err);
  }
}

/** 断言式记录：把 Error 展开成可读字段 */
export function logError(kind, err, data = {}) {
  logEvent(kind, {
    ...data,
    status: err?.status,
    message: err?.message ?? String(err),
    stack: err?.stack,
  });
}
