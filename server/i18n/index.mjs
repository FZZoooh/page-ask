/**
 * 后端侧文案入口：默认 `zh-CN`，按 `?lang=` / `Accept-Language` 选字典。
 *
 * 现有 `zh-CN` 与伪本地化 `en-XA`（只用于检查布局，不是真实语言）；接口按多语言设计：
 * 拿不到匹配语言时回退到默认，绝不抛错。
 * 前端扩展有自己的 `src/lib/i18n.ts`；这里只服务后端直出的内容（配置页、错误体）。
 */
import zhCN, { locale as zhCNLocale } from './zh-CN.mjs';
import enUS, { locale as enUSLocale } from './en-US.mjs';
import enXA, { locale as enXALocale } from './en-XA.mjs';

const DICTS = new Map([
  [zhCNLocale, zhCN],
  [enUSLocale, enUS],
  [enXALocale, enXA],
]);

export const DEFAULT_LOCALE = zhCNLocale;
export const SUPPORTED_LOCALES = [...DICTS.keys()];

function normalizeTag(tag) {
  const raw = String(tag ?? '').trim();
  if (!raw) return '';
  const [lang, region] = raw.split('-');
  if (!lang) return '';
  return region ? `${lang.toLowerCase()}-${region.toUpperCase()}` : lang.toLowerCase();
}

function lookup(tag) {
  if (!tag) return undefined;
  if (DICTS.has(tag)) return tag;
  // 先做大小写归一，再接受同语种的宽泛匹配（zh、zh-Hans → zh-CN；en、en-GB → en-US）
  const normalized = normalizeTag(tag);
  if (DICTS.has(normalized)) return normalized;
  const base = String(tag).toLowerCase().split('-')[0];
  for (const locale of DICTS.keys()) {
    if (locale.toLowerCase().split('-')[0] === base) return locale;
  }
  return undefined;
}

/** 解析 `Accept-Language`；按 q 值排序后取第一个有字典的语言。 */
export function negotiateLocale({ acceptLanguage = '', queryLang = '' } = {}) {
  const fromQuery = lookup(queryLang);
  if (fromQuery) return fromQuery;

  const candidates = String(acceptLanguage)
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const qParam = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const q = qParam ? Number(qParam.slice(2)) : 1;
      return { tag: normalizeTag(tag), q: Number.isFinite(q) ? q : 1 };
    })
    .filter((c) => c.tag)
    .sort((a, b) => b.q - a.q);

  for (const candidate of candidates) {
    const hit = lookup(candidate.tag);
    if (hit) return hit;
  }
  return DEFAULT_LOCALE;
}

/** 取整份字典（配置页会把它原样嵌进页面给客户端脚本用）。 */
export function dictionary(locale = DEFAULT_LOCALE) {
  return DICTS.get(locale) ?? zhCN;
}

/** 替换 `{name}` 占位符；没有传入的值保持原样，避免显示成 undefined。 */
export function format(template, vars) {
  const text = String(template ?? '');
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name) =>
    vars[name] === undefined || vars[name] === null ? whole : String(vars[name]),
  );
}

export function has(key, locale = DEFAULT_LOCALE) {
  return Object.prototype.hasOwnProperty.call(dictionary(locale), key);
}

export function t(key, vars, locale = DEFAULT_LOCALE) {
  const dict = dictionary(locale);
  return format(dict[key] ?? key, vars);
}
