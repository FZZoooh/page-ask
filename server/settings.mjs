/**
 * 配置的唯一真源：`~/.config/pageask/settings.json`（Windows 上即 `C:\Users\<你>\.config\pageask\settings.json`）。
 * 目录不存在会自动创建（含 `.config` 这一层）。
 *
 * 早期配置全在环境变量里（DEEPSEEK_API_KEY / PAGEASK_MODEL / PAGEASK_BASE_URL），
 * 现在一律走文件 + 后端配置页（`/settings`），**不再读取这些环境变量**：
 * 只留 `PAGEASK_DATA_DIR`、`PAGEASK_PORT`、`PAGEASK_EXTENSION_ID` 决定「服务自己怎么起来」。
 *
 * 老位置（`<数据目录>/settings.json`）在启动时会被自动搬到新位置，搬成功后删掉旧文件。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** 数据库、截图、日志还在数据目录里（和数据一起备份/清理更方便） */
export const dataDir = resolve(process.env.PAGEASK_DATA_DIR ?? join(import.meta.dirname, 'data'));

/** 配置单独放在家目录的 XDG 风格路径下 */
export const configDir = join(homedir(), '.config', 'pageask');
export const settingsFile = join(configDir, 'settings.json');
/** 旧位置：只在迁移时被读一次 */
const legacySettingsFile = join(dataDir, 'settings.json');

export const DEFAULTS = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  apiKey: '',
  // 会话状态：
  //   auto    —— 有锚点就试有状态（previous_response_id），上游不认则自动退回无状态
  //   on      —— 强制有状态
  //   off     —— 强制无状态（每轮重发完整历史，DeepSeek 这类实现只支持这个）
  state: 'auto',
};

/** 会话状态三档的合法值 */
export const STATE_MODES = ['auto', 'on', 'off'];

/** 文件里可能缺字段/带空白，统一收敛成可用形状 */
function normalize(raw) {
  const baseUrl = String(raw?.baseUrl ?? DEFAULTS.baseUrl).trim().replace(/\/+$/, '') || DEFAULTS.baseUrl;
  const model = String(raw?.model ?? DEFAULTS.model).trim() || DEFAULTS.model;
  const apiKey = String(raw?.apiKey ?? '').trim();
  const rawState = String(raw?.state ?? DEFAULTS.state).trim().toLowerCase();
  const state = STATE_MODES.includes(rawState) ? rawState : DEFAULTS.state;
  return { baseUrl, model, apiKey, state };
}

/**
 * 每次调用都重新读一遍文件：配置页保存后，下一个请求立刻生效，不需要重启后端。
 * 文件很小（几百字节），读失败的场景（还没保存过）由调用方兜底。
 *
 * 刻意**不读任何环境变量**：Key / 地址 / 模型的唯一来源就是这个文件，
 * 免得「改了文件却没生效、其实是环境变量抢先」这类难查的问题。
 */
export function readSettings() {
  migrateLegacySettings();

  let text;
  try {
    text = readFileSync(settingsFile, 'utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      // 读不到（权限/占用）不是「没有配置」：绝不能拿默认值把它盖掉
      console.error(`[pageask] 读配置文件失败，本次使用默认值：${err?.message ?? err}`);
      return normalize({});
    }
    // 还没有文件：先写一份默认的，用户才知道该改哪儿
    const initial = normalize({});
    try {
      writeSettings(initial);
      console.log(`[pageask] 已生成配置文件 ${settingsFile}`);
    } catch (e) {
      console.error(`[pageask] 写配置文件失败：${e?.message ?? e}`);
    }
    return initial;
  }

  try {
    return normalize(JSON.parse(text));
  } catch (err) {
    // 解析失败时先备份原文件再当默认值用：里面可能有用户的 Key，
    // 直接覆盖等于让 Key 凭空消失（这正是旧实现的问题）。
    quarantineBroken(err);
    return normalize({});
  }
}

/** 把损坏的配置改名保留，绝不直接覆盖 */
function quarantineBroken(err) {
  const target = `${settingsFile}.broken-${Date.now()}-${process.pid}`;
  try {
    renameSync(settingsFile, target);
    console.error(`[pageask] 配置文件解析失败（${err?.message ?? err}），已备份到 ${target}`);
  } catch (e) {
    console.error(`[pageask] 配置文件解析失败，且备份失败：${e?.message ?? e}`);
  }
}

/** 合并式保存：patch 里没有的字段保持原样，`apiKey: ''` 表示「不动」，`clearApiKey: true` 才是清空 */
export function writeSettings(patch) {
  const current = readExisting();
  const next = normalize({
    baseUrl: patch.baseUrl ?? current.baseUrl,
    model: patch.model ?? current.model,
    apiKey: patch.clearApiKey
      ? ''
      : patch.apiKey === undefined || patch.apiKey === ''
        ? current.apiKey
        : patch.apiKey,
    state: patch.state ?? current.state,
  });
  // 目录 0700、文件 0600：Key 明文躺在磁盘上，至少别让同机其他用户随手读到
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const tmp = `${settingsFile}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, settingsFile);
  try {
    chmodSync(settingsFile, 0o600);
  } catch {
    /* Windows 上 chmod 能力有限，失败不影响功能 */
  }
  return next;
}

function readExisting() {
  let text;
  try {
    text = readFileSync(settingsFile, 'utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT') console.error(`[pageask] 读配置文件失败：${err?.message ?? err}`);
    return normalize({});
  }
  try {
    return normalize(JSON.parse(text));
  } catch (err) {
    quarantineBroken(err);
    return normalize({});
  }
}

/**
 * 把老位置的 `settings.json` 搬到 `~/.config/pageask/`。
 * 先写新文件、成功后再删旧的：中途失败也不会让 Key 凭空消失。
 */
function migrateLegacySettings() {
  if (legacySettingsFile === settingsFile || !existsSync(legacySettingsFile)) return;
  if (existsSync(settingsFile)) return; // 新位置已经有了，以它为准，不覆盖
  try {
    const raw = JSON.parse(readFileSync(legacySettingsFile, 'utf8'));
    const next = normalize(raw);
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const tmp = `${settingsFile}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, settingsFile);
    try {
      chmodSync(settingsFile, 0o600);
    } catch {
      /* Windows 上 chmod 能力有限 */
    }
    unlinkSync(legacySettingsFile);
    console.log(`[pageask] 配置已迁移：${legacySettingsFile} → ${settingsFile}`);
  } catch (err) {
    console.error(`[pageask] 配置迁移失败（旧文件保留在原处）：${err?.message ?? err}`);
  }
}

/** `sk-554…a1b2`：给页面显示用，永不把完整 Key 发回浏览器 */
export function maskKey(key) {
  const k = String(key ?? '');
  if (!k) return '';
  if (k.length <= 10) return `…${k.slice(-2)}`;
  return `${k.slice(0, 6)}…${k.slice(-4)}`;
}

/** 给配置页的视图（不含明文 Key） */
export function publicSettings(s) {
  const cur = s ?? readSettings();
  return {
    baseUrl: cur.baseUrl,
    model: cur.model,
    state: cur.state,
    hasKey: Boolean(cur.apiKey),
    apiKeyMasked: maskKey(cur.apiKey),
    settingsFile,
    exists: existsSync(settingsFile),
  };
}
