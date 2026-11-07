// 上游 baseUrl 的路径约定：配置里可能写 https://api.deepseek.com，
// 也可能写 https://api.openai.com/v1。统一补成「以 /v1 结尾」再拼端点，
// 避免 /responses 与 /v1/tools/* 一个少一段、一个多一段。
export function withV1(baseUrl) {
  const root = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  return /\/v1$/i.test(root) ? root : `${root}/v1`;
}
