// upstream baseUrl path convention: config may say https://api.deepseek.com, or
// https://api.openai.com/v1. Always normalize to "ends in /v1" before appending
// an endpoint, so /responses and /v1/tools/* don't end up one segment short or one too long.
export function withV1(baseUrl) {
  const root = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  // Azure OpenAI already carries its deployment path in the base URL, e.g.
  // https://r.openai.azure.com/openai/deployments/d — appending /v1 would break it.
  try {
    const url = new URL(root);
    if (/\.azure\.com$/i.test(url.hostname) && /\/openai(\/|$)/i.test(url.pathname)) return root;
  } catch {
    /* not a URL; fall through to the /v1 rule and let the request fail with a clear status */
  }
  return /\/v1$/i.test(root) ? root : `${root}/v1`;
}
