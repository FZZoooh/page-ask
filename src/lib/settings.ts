/** 扩展自己的设置：现在只关心「后端地址」和显示偏好；模型与 Key 都在后端的 settings.json 里。 */
import type { LocalePreference } from './i18n';

export interface Settings {
  /** 本地后端地址，例如 http://127.0.0.1:8787 */
  backendUrl: string;
  /** 显示详细信息：页面卡片、思考/工具折叠块、回答末尾的统计。关掉就是清爽模式 */
  verbose: boolean;
  /** 后端设了 PAGEASK_TOKEN 时，浏览器端要带同一个令牌；后端没设就留空 */
  token: string;
  /** 界面语言；auto 跟随浏览器，其余强制指定 */
  locale: LocalePreference;
}

export const DEFAULT_SETTINGS: Settings = {
  backendUrl: 'http://127.0.0.1:8787',
  verbose: true,
  token: '',
  locale: 'auto',
};

const KEY = 'pageask.settings.v2';
const LEGACY_KEY = 'pageask.settings.v1'; // P1 的 {baseUrl, model, apiKey}，只用来迁移

/** 只认已知字段：老版本存下的 model 之类残渣不往状态里带 */
function pick(raw: Partial<Settings> | undefined): Settings {
  return {
    backendUrl: raw?.backendUrl?.trim() || DEFAULT_SETTINGS.backendUrl,
    verbose: raw?.verbose !== false,
    token: raw?.token?.trim() ?? '',
    locale: raw?.locale === 'zh-CN' || raw?.locale === 'en-US' ? raw.locale : 'auto',
  };
}

export async function loadSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get([KEY, LEGACY_KEY]);
  const current = stored[KEY] as Partial<Settings> | undefined;
  if (current) return pick(current);

  // 从 P1 的配置迁移：地址保留，模型和 Key 都交给后端
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
    // 后端地址只取 origin + pathname：`?a=1` 拼上 `/chat` 会变成 `?a=1/chat`，打到根路径
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/+$/, '');
  } catch {
    return raw.replace(/\/+$/, '');
  }
}

/** 去掉 #hash 与纯追踪参数：同一篇文章的锚点/utm 不该算成两个会话 */
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
