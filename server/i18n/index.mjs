/**
 * Backend-side message entry: `zh-CN` by default, dictionary chosen by `?lang=` / `Accept-Language`.
 *
 * Currently `zh-CN` plus the pseudo-localization `en-XA` (layout checks only, not a real language);
 * multi-locale by design: an unmatched locale falls back to the default and never throws. The
 * extension has its own `src/lib/i18n.ts`; this serves only backend-emitted content (settings page, errors).
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
  // normalize case first, then accept a broad same-language match (zh, zh-Hans → zh-CN; en, en-GB → en-US)
  const normalized = normalizeTag(tag);
  if (DICTS.has(normalized)) return normalized;
  const base = String(tag).toLowerCase().split('-')[0];
  for (const locale of DICTS.keys()) {
    if (locale.toLowerCase().split('-')[0] === base) return locale;
  }
  return undefined;
}

/** parse `Accept-Language`; sort by q value and take the first language that has a dictionary */
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

/** the whole dictionary (the settings page embeds it verbatim into the page for the client script) */
export function dictionary(locale = DEFAULT_LOCALE) {
  return DICTS.get(locale) ?? zhCN;
}

/** replace `{name}` placeholders; a value not passed in stays as-is, so nothing renders as undefined */
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
