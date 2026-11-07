/**
 * 面向用户的错误码。
 *
 * 约定：HTTP 错误体与 SSE 的 `error` 事件都带 `code`（以及可选的 `params`），
 * 前端用 `t('error.' + code)` 渲染本地文案；`error` / `message` 字段只是给
 * curl、日志和「未知 code」兜底的中文，不保证会展示给用户。
 *
 * 加新 code 时三处一起改：本文件、`src/lib/i18n.ts` 的 `error.*`、以及
 * `docs/` 或提交说明里的契约描述。
 */

export const ERROR_MESSAGES = {
  'auth.origin': '请求来源不被允许',
  'auth.forbidden': '没有权限访问这个接口',
  'auth.bad_token': '访问令牌不正确',

  'request.bad_body': '请求体不合法，或超过了大小限制',
  'request.missing_url': '缺少页面地址',
  'request.not_found': '接口不存在',

  'conversation.not_found': '找不到这个会话',
  'conversation.busy': '这一轮还在生成，请稍后再试',
  'conversation.no_pending': '没有待恢复的提问',

  'settings.invalid_base_url': '上游地址要以 http:// 或 https:// 开头',
  'settings.missing_api_key': '还没有配置 API Key',

  'chat.empty_text': '问题不能为空',
  'chat.missing_page': '缺少页面信息',

  'upstream.bad_request': '请求被上游拒绝（400）',
  'upstream.auth': 'API Key 无效或已过期',
  'upstream.balance': '账号余额不足',
  'upstream.model_not_found': '模型不存在，检查配置页里的默认模型',
  'upstream.invalid_request': '请求参数不合法（422）',
  'upstream.rate_limit': '请求过于频繁或超出配额',
  'upstream.empty': '上游没有返回任何内容',
  'upstream.timeout': '上游在 {seconds} 秒内没有响应',
  'upstream.status': '上游返回 {status}',
  'upstream.failed': '上游返回失败',

  'pdf.missing_source': '缺少 PDF 数据',
  'pdf.not_pdf': '不是 PDF 文件',
  'pdf.bad_file_url': '本地文件地址不合法',
  'pdf.not_found': '读不到这个本地文件',
  'pdf.not_file': '这个路径不是文件',
  'pdf.too_big': 'PDF 太大了，不应大于 64 MB',
  'pdf.bad': 'PDF 解析失败',
  'pdf.failed': 'PDF 解析失败',
};

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
  const body = { error: message || ERROR_MESSAGES[code] || code, code };
  if (params) {
    const clean = Object.fromEntries(
      Object.entries(params).filter(([, value]) => value !== undefined && value !== null),
    );
    if (Object.keys(clean).length > 0) body.params = clean;
  }
  return body;
}
