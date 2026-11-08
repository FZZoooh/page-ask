// upstream baseUrl path convention: config may say https://api.deepseek.com, or
// https://api.openai.com/v1. Always normalize to "ends in /v1" before appending
// an endpoint, so /responses and /v1/tools/* don't end up one segment short or one too long.
export function withV1(baseUrl) {
  const root = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  return /\/v1$/i.test(root) ? root : `${root}/v1`;
}
