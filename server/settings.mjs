/**
 * Single source of truth for config: `~/.config/pageask/settings.json` — on Windows
 * `C:\Users\<you>\.config\pageask\settings.json`. The dir is auto-created (incl. `.config`).
 *
 * **Everything is in this file and nothing is read from the environment**: model settings
 * (baseUrl / model / apiKey / state) plus service settings (port / token / dataDir). The extension
 * ID is deliberately absent: it follows from `extension-key.json`, which the build and the backend
 * both read, so it is a build property rather than a per-machine setting.
 * Config used to live in env vars, then split between env vars and this file; the split meant
 * "I changed it but nothing happened" and made the tray and the backend disagree about the port,
 * so the file is now the only source. Startup arguments cannot override it.
 *
 * The old location (`<data dir>/settings.json`) is auto-migrated at startup; the old file is deleted after.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

/** repo root: relative `dataDir` values and the default data dir hang off it, not off the cwd */
const REPO_ROOT = resolve(import.meta.dirname, '..');
/**
 * Resolve `dataDir`: empty means `<repo>/server/data` (db, screenshots and logs stay together,
 * easy to back up or wipe), `~` expands to the home dir, and relative paths resolve against the
 * repo root so starting the backend from another cwd is safe.
 */
function resolveDataDir(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return join(import.meta.dirname, 'data');
  const expanded = raw === '~' || raw.startsWith(`~${sep}`) ? join(homedir(), raw.slice(1)) : raw;
  return resolve(REPO_ROOT, expanded);
}

/** config lives separately, under an XDG-style path in the home directory */
export const configDir = join(homedir(), '.config', 'pageask');
export const settingsFile = join(configDir, 'settings.json');

/** raw parse with no side effects: `dataDir` is needed before the file is normalized/created */
function readRawSettings() {
  try {
    return JSON.parse(readFileSync(settingsFile, 'utf8'));
  } catch {
    return null;
  }
}

export const dataDir = resolveDataDir(readRawSettings()?.dataDir);
/** old location: read once, only during migration */
const legacySettingsFile = join(dataDir, 'settings.json');

export const DEFAULTS = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  apiKey: '',
  // conversation state:
  //   auto    —— with an anchor, try stateful (previous_response_id); fall back if upstream says no
  //   on      —— force stateful
  //   off     —— force stateless (resend full history each turn; DeepSeek-like impls only do this)
  state: 'auto',
  // service settings: bound at startup, so changing them needs a backend restart
  port: 8787,
  token: '',
  /** empty = `<repo>/server/data` */
  dataDir: '',
};

/** legal values for the three conversation-state modes */
export const STATE_MODES = ['auto', 'on', 'off'];

/** the file may miss fields or carry whitespace; normalize it into a usable shape */
function normalize(raw) {
  const baseUrl = String(raw?.baseUrl ?? DEFAULTS.baseUrl).trim().replace(/\/+$/, '') || DEFAULTS.baseUrl;
  const model = String(raw?.model ?? DEFAULTS.model).trim() || DEFAULTS.model;
  const apiKey = String(raw?.apiKey ?? '').trim();
  const rawState = String(raw?.state ?? DEFAULTS.state).trim().toLowerCase();
  const state = STATE_MODES.includes(rawState) ? rawState : DEFAULTS.state;
  const port = Number(raw?.port ?? DEFAULTS.port);
  const validPort = Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULTS.port;
  const token = String(raw?.token ?? '').trim();
  const dataDirRaw = String(raw?.dataDir ?? DEFAULTS.dataDir).trim();
  return { baseUrl, model, apiKey, state, port: validPort, token, dataDir: dataDirRaw };
}

/**
 * Re-read the file on every call so a save on the settings page applies to the next request
 * with no restart. The file is tiny (hundreds of bytes); callers cover "never saved yet".
 *
 * Deliberately **reads no environment variables**: the file is the sole source of everything,
 * so "changed the file but nothing happened — an env var won" can't happen.
 */
export function readSettings() {
  migrateLegacySettings();

  let text;
  try {
    text = readFileSync(settingsFile, 'utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      // a read failure (permissions/busy) is not "no config": never paper over it with defaults
      console.error(`[pageask] failed to read config file; using defaults for this run: ${err?.message ?? err}`);
      return normalize({});
    }
    // no file yet: write a default one first, so the user knows where to edit
    const initial = normalize({});
    try {
      writeSettings(initial);
      console.log(`[pageask] created config file ${settingsFile}`);
    } catch (e) {
      console.error(`[pageask] failed to write config file: ${e?.message ?? e}`);
    }
    return initial;
  }

  try {
    const raw = JSON.parse(text);
    const settings = normalize(raw);
    warnLegacyExtensionId(raw);
    upgradeShape(raw, settings);
    return settings;
  } catch (err) {
    // on a parse failure, back up the file before falling back to defaults: it may hold
    // the user's key, and overwriting it would make the key vanish (the old bug).
    quarantineBroken(err);
    return normalize({});
  }
}

/**
 * Files written before the ID became derived still carry an `extensionId` field. Ignoring it
 * silently would recreate the "I changed it but nothing happened" trap, so mention it once.
 */
let legacyIdWarned = false;
function warnLegacyExtensionId(raw) {
  if (legacyIdWarned || typeof raw !== 'object' || raw === null || !('extensionId' in raw)) return;
  legacyIdWarned = true;
  console.log(
    '[pageask] settings.json still has extensionId; it is derived from extension-key.json now and will be dropped on the next save',
  );
}

/**
 * Older files only hold the model fields; write the service fields back once so they are
 * visible and editable instead of staying invisible defaults. Runs at most once per process.
 */
let shapeChecked = false;
function upgradeShape(raw, settings) {
  if (shapeChecked) return;
  shapeChecked = true;
  const missing = Object.keys(DEFAULTS).filter((key) => !(key in (raw ?? {})));
  if (!missing.length) return;
  try {
    writeSettings(settings);
    console.log(`[pageask] config file gained new fields: ${missing.join(', ')}`);
  } catch (err) {
    console.error(`[pageask] could not add new fields to the config file: ${err?.message ?? err}`);
  }
}

/** rename a corrupt config out of the way and keep it; never overwrite it */
function quarantineBroken(err) {
  const target = `${settingsFile}.broken-${Date.now()}-${process.pid}`;
  try {
    renameSync(settingsFile, target);
    console.error(`[pageask] config file is not valid JSON (${err?.message ?? err}); backed up to ${target}`);
  } catch (e) {
    console.error(`[pageask] config file is not valid JSON, and backing it up failed: ${e?.message ?? e}`);
  }
}

/** merged save: fields missing from patch stay put, `apiKey: ''` means "leave it", `clearApiKey: true` clears */
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
    port: patch.port ?? current.port,
    token: patch.token ?? current.token,
    dataDir: patch.dataDir ?? current.dataDir,
  });
  // dir 0700, file 0600: the key sits in plaintext on disk — at least keep other users on the box out
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const tmp = `${settingsFile}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, settingsFile);
  try {
    chmodSync(settingsFile, 0o600);
  } catch {
    /* chmod is limited on Windows; failure doesn't affect functionality */
  }
  return next;
}

function readExisting() {
  let text;
  try {
    text = readFileSync(settingsFile, 'utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT') console.error(`[pageask] failed to read config file: ${err?.message ?? err}`);
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
 * Move the legacy `settings.json` to `~/.config/pageask/`. Write the new file first,
 * delete the old one only after that succeeds, so a mid-way failure never loses the key.
 */
function migrateLegacySettings() {
  if (legacySettingsFile === settingsFile || !existsSync(legacySettingsFile)) return;
  if (existsSync(settingsFile)) return; // new location already exists; it wins, don't overwrite
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
      /* chmod is limited on Windows */
    }
    unlinkSync(legacySettingsFile);
    console.log(`[pageask] migrated config: ${legacySettingsFile} -> ${settingsFile}`);
  } catch (err) {
    console.error(`[pageask] config migration failed (old file left in place): ${err?.message ?? err}`);
  }
}

/** `sk-554…a1b2`: for display only — the full key never goes back to the browser */
export function maskKey(key) {
  const k = String(key ?? '');
  if (!k) return '';
  if (k.length <= 10) return `…${k.slice(-2)}`;
  return `${k.slice(0, 6)}…${k.slice(-4)}`;
}

/** the view the settings page gets (no plaintext key) */
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
