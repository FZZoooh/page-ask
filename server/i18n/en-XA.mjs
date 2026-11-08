/**
 * 伪本地化（pseudo-locale）：给布局/截断测试用，不是给用户的语言。
 *
 * 把 zh-CN 的每条文案包上 `[!! … !!]`，并把汉字重复一遍，让文本明显变长；
 * 占位符 `{name}` 原样保留，所以 `format()` 仍然能替换。
 */
import base, { locale as baseLocale } from './zh-CN.mjs';

export const locale = 'en-XA';

function pseudo(text) {
  return `[!! ${String(text).replace(/[\u4e00-\u9fff]/g, (ch) => ch + ch)} !!]`;
}

const messages = Object.fromEntries(
  Object.entries(base).map(([key, value]) => [key, typeof value === 'string' ? pseudo(value) : value]),
);

export { baseLocale };
export default messages;
