/**
 * 面向用户的错误码。
 *
 * 约定：HTTP 错误体与 SSE 的 `error` 事件都带 `code`（以及可选的 `params`），
 * 前端用 `t('error.' + code)` 渲染本地文案；`error` / `message` 字段只是给
 * curl、日志和「未知 code」兜底的中文，不保证会展示给用户。
 *
 * 文案在 `server/i18n/zh-CN.mjs` 的 `error.*` 里；加新 code 时三处一起改：
 * 本文件、`src/lib/i18n.ts` 的 `error.*`、以及 `docs/` 或提交说明里的契约描述。
 */
import { has, t } from './i18n/index.mjs';

const UPSTREAM_CODES = {
  400: 'upstream.bad_request',
  401: 'upstream.auth',
  402: 'upstream.balance',
  404: 'upstream.model_not_found',
  422: 'upstream.invalid_request',
  429: 'upstream.rate_limit',
  504: 'upstream.timeout',
};

/** 把上游 HTTP 状态映射成稳定 code；未知状态统一 `upstream.status`（带 status 参数）。 */
export function upstreamErrorCode(status) {
  return UPSTREAM_CODES[status] ?? 'upstream.status';
}

/** PdfError 的旧下划线 code → 面向用户的点分 code。 */
export function normalizePdfCode(code) {
  return (
    {
      bad_pdf: 'pdf.bad',
      pdf_bad_file_url: 'pdf.bad_file_url',
      pdf_not_found: 'pdf.not_found',
      pdf_not_file: 'pdf.not_file',
      pdf_too_big: 'pdf.too_big',
      pdf_failed: 'pdf.failed',
    }[code] ?? 'pdf.failed'
  );
}

/**
 * 组装错误体：`error` 是给人看的 fallback，`code`/`params` 才是协议。
 * params 里不要放整句或敏感的本地路径。
 */
export function errorPayload(code, params = undefined, message = undefined) {
  const key = `error.${code}`;
  const body = { error: message || (has(key) ? t(key, params) : code), code };
  if (params) {
    const clean = Object.fromEntries(
      Object.entries(params).filter(([, value]) => value !== undefined && value !== null),
    );
    if (Object.keys(clean).length > 0) body.params = clean;
  }
  return body;
}
