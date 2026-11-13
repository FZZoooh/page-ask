/** Extension settings: backend URL and display prefs only; model + key live in the backend's settings.json. */
import type { LocalePreference } from './i18n';

/** Reading size for answers; formulas use em units and scale with it. */
export type FontSize = 'small' | 'normal' | 'large' | 'xlarge';

export interface Settings {
  /** Local backend address, e.g. http://127.0.0.1:8787 */
  backendUrl: string;
  /** Show detail: page card, reasoning/tool folds, stats under the answer. Off = clean mode */
  verbose: boolean;
  /** Set when the backend's settings.json has a token: send the same token; leave blank when it has none */
  token: string;
  /** UI language; auto follows the browser, anything else is forced */
  locale: LocalePreference;
  /** Answer text size; KaTeX is em-based, so formulas grow/shrink with the same value */
  fontSize: FontSize;
  /** A plain-text paste of at least pasteAsFileBytes (UTF-8) becomes a .txt attachment instead of text */
  pasteAsFile: boolean;
  pasteAsFileBytes: number;
}

export const DEFAULT_SETTINGS: Settings = {
  backendUrl: 'http://127.0.0.1:8787',
  verbose: true,
  token: '',
  locale: 'auto',
  fontSize: 'normal',
  pasteAsFile: true,
  pasteAsFileBytes: 10000,
};

export function validPasteBytes(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
}

const KEY = 'pageask.settings.v2';
const LEGACY_KEY = 'pageask.settings.v1'; // P1's {baseUrl, model, apiKey}; read for migration only

/** Known fields only: leftovers such as the old model key never reach state */
function pick(raw: Partial<Settings> | undefined): Settings {
  const fontSize = raw?.fontSize;
  const pasteBytes = raw?.pasteAsFileBytes;
  return {
    backendUrl: raw?.backendUrl?.trim() || DEFAULT_SETTINGS.backendUrl,
    verbose: raw?.verbose !== false,
    token: raw?.token?.trim() ?? '',
    locale: raw?.locale === 'zh-CN' || raw?.locale === 'en-US' ? raw.locale : 'auto',
    fontSize: fontSize === 'small' || fontSize === 'large' || fontSize === 'xlarge' ? fontSize : 'normal',
    pasteAsFile: raw?.pasteAsFile !== false,
    pasteAsFileBytes: validPasteBytes(pasteBytes) ? pasteBytes : DEFAULT_SETTINGS.pasteAsFileBytes,
  };
}

export async function loadSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get([KEY, LEGACY_KEY]);
  const current = stored[KEY] as Partial<Settings> | undefined;
  if (current) return pick(current);

  // Migrate from P1: keep the URL, hand model and key to the backend
  const legacy = stored[LEGACY_KEY] as { baseUrl?: string } | undefined;
  if (legacy) {
    const migrated: Settings = { ...DEFAULT_SETTINGS, backendUrl: legacy.baseUrl?.trim() || DEFAULT_SETTINGS.backendUrl };
    await saveSettings(migrated);
    return migrated;
  }
  return DEFAULT_SETTINGS;
}

export async function saveSettings(next: Settings): Promise<void> {
  await browser.storage.local.set({ [KEY]: next });
}

export const isConfigured = (s: Settings | null): s is Settings => {
  const raw = s?.backendUrl?.trim();
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
};

export function baseUrl(s: Settings): string {
  const raw = s.backendUrl.trim();
  try {
    const u = new URL(raw);
    // Keep origin + pathname only: `?a=1` plus `/chat` would read as `?a=1/chat` and hit the root path
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/+$/, '');
  } catch {
    return raw.replace(/\/+$/, '');
  }
}

/** Tracking params are page furniture: a utm on the same article is not a second conversation */
const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'fbclid',
  'gclid',
  'spm',
  'ref',
]);

/**
 * Drop #hash and tracking params: an anchor or utm on the same article is not a second
 * conversation. Everything else stays, including an explicit non-default port - `new URL()` only
 * drops 80/443 - so `127.0.0.1:3000` and `127.0.0.1:8080` remain separate sites in the history.
 */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = '';
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) u.searchParams.delete(key);
    }
    return u.toString();
  } catch {
    return raw;
  }
}

/**
 * True when two URLs point at the same document. `expectedUrl` comes from readActiveTab()
 * (already normalized), while tab.url comes straight from the browser and still carries
 * tracking params and a hash; comparing the raw strings silently disables screenshots.
 */
export function sameDocumentUrl(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  return normalizeUrl(a) === normalizeUrl(b);
}
