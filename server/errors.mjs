/**
 * User-facing error codes.
 *
 * Contract: HTTP error bodies and the SSE `error` event both carry `code` (+ optional `params`);
 * the front end renders localized text with `t('error.' + code)`, while `error` / `message`
 * are only a Chinese fallback for curl, logs and unknown codes — not guaranteed to reach the user.
 *
 * Text is under `error.*` in `server/i18n/zh-CN.mjs`; when adding a code, change three
 * places together: this file, `error.*` in `src/lib/i18n.ts`, and the contract in `docs/`/commit.
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

/** map an upstream HTTP status to a stable code; unknown ones become `upstream.status` (+ status param) */
export function upstreamErrorCode(status) {
  return UPSTREAM_CODES[status] ?? 'upstream.status';
}

/** PdfError's legacy underscore codes → the user-facing dotted codes */
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
 * Build the error body: `error` is a human-readable fallback, `code`/`params` are the protocol.
 * Never put whole sentences or sensitive local paths in params.
 */
export function errorPayload(code, params = undefined, message = undefined) {
  const key = `error.${code}`;
  const text = message || (has(key) ? t(key, params) : code);
  // `error` is the historical field; `message` is the documented fallback name. Emit both so
  // third-party clients and older readers agree, while `code` stays the contract.
  const body = { error: text, message: text, code };
  if (params) {
    const clean = Object.fromEntries(
      Object.entries(params).filter(([, value]) => value !== undefined && value !== null),
    );
    if (Object.keys(clean).length > 0) body.params = clean;
  }
  return body;
}
