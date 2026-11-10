import { useState } from 'react';
import { checkHealth } from '@/lib/chat';
import { t, type MessageKey } from '@/lib/i18n';
import { DEFAULT_SETTINGS, saveSettings, type Settings } from '@/lib/settings';

interface Props {
  value: Settings;
  onDone: (next: Settings) => void;
  onClose: () => void;
}

type Probe = { ok: true; key: MessageKey; params?: Record<string, string | number> } | { ok: false; text: string };

/** Accept http(s) URLs only; null on parse failure, so page content is never posted to a bogus address */
function parseBackendUrl(raw: string): URL | null {
  try {
    const url = new URL(raw.trim());
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return null;
    // Must match the backend's own baseUrl validation: no credentials, query or hash.
    if (url.username || url.password || url.search || url.hash) return null;
    // `localhost.` / `127.0.0.1.` are valid forms; strip the trailing dot before the loopback check
    url.hostname = url.hostname.replace(/\.+$/, '');
    return url;
  } catch {
    return null;
  }
}

/** Trust the local backend by default; any other host needs a second confirmation from the user */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function SettingsPanel({ value, onDone, onClose }: Props) {
  const [draft, setDraft] = useState<Settings>(value);
  const [saving, setSaving] = useState(false);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [probing, setProbing] = useState(false);

  const patch = (p: Partial<Settings>) => setDraft((d) => ({ ...d, ...p }));

  const normalized = (): Settings => {
    const raw = draft.backendUrl.trim() || DEFAULT_SETTINGS.backendUrl;
    const parsed = parseBackendUrl(raw);
    return {
      // Persist the canonical form, so `localhost.` cannot be saved and then fail the exact-origin CORS check.
      backendUrl: parsed ? parsed.href.replace(/\/+$/, '') : raw,
      verbose: draft.verbose,
      token: draft.token.trim(),
      locale: draft.locale,
      fontSize: draft.fontSize,
    };
  };

  /** Validate the draft URL; on failure it writes probe itself, so callers only need to return */
  const validated = (): URL | null => {
    const parsed = parseBackendUrl(normalized().backendUrl);
    if (!parsed) setProbe({ ok: false, text: t('settings.invalidUrl') });
    return parsed;
  };

  const parsedDraft = parseBackendUrl(normalized().backendUrl);
  const remoteHost = parsedDraft && !LOOPBACK_HOSTS.has(parsedDraft.hostname) ? parsedDraft.host : null;

  const handleSave = async () => {
    const parsed = validated();
    if (!parsed) return;
    if (!LOOPBACK_HOSTS.has(parsed.hostname) && !window.confirm(t('settings.remoteConfirm', { host: parsed.host }))) {
      return;
    }
    setSaving(true);
    const next = normalized();
    try {
      await saveSettings(next);
      onDone(next);
    } catch (err) {
      setProbe({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    const parsed = validated();
    if (!parsed) return;
    // The connection test sends the current token to that address: confirm first for non-local hosts
    if (!LOOPBACK_HOSTS.has(parsed.hostname) && !window.confirm(t('settings.remoteConfirm', { host: parsed.host }))) {
      return;
    }
    setProbing(true);
    setProbe(null);
    try {
      const info = await checkHealth(normalized());
      setProbe({ ok: true, key: 'settings.probeOk', params: { model: info.model } });
    } catch (err) {
      setProbe({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setProbing(false);
    }
  };

  return (
    <section className="card settings">
      <div className="card-head">
        <div className="card-title">{t('settings.title')}</div>
        <button className="ghost" onClick={onClose}>
          {t('settings.close')}
        </button>
      </div>

      <label className="field">
        <span>{t('settings.backendUrl')}</span>
        <input
          value={draft.backendUrl}
          onChange={(e) => patch({ backendUrl: e.target.value })}
          spellCheck={false}
          placeholder={DEFAULT_SETTINGS.backendUrl}
        />
        <small>{t('settings.backendHint')}</small>
        {remoteHost && <small className="warn">{t('settings.remoteHint', { host: remoteHost })}</small>}
      </label>

      <label className="field">
        <span>{t('settings.token')}</span>
        <input
          type="password"
          value={draft.token}
          onChange={(e) => patch({ token: e.target.value })}
          spellCheck={false}
          autoComplete="off"
          placeholder={t('settings.tokenPlaceholder')}
        />
        <small>{t('settings.tokenHint')}</small>
      </label>

      <label className="field">
        <span>{t('settings.language')}</span>
        <select
          value={draft.locale}
          onChange={(e) => patch({ locale: e.target.value as Settings['locale'] })}
        >
          <option value="auto">{t('settings.languageAuto')}</option>
          <option value="zh-CN">{t('settings.languageZh')}</option>
          <option value="en-US">{t('settings.languageEn')}</option>
        </select>
      </label>

      <label className="field">
        <span>{t('settings.fontSize')}</span>
        <select
          value={draft.fontSize}
          onChange={(e) => patch({ fontSize: e.target.value as Settings['fontSize'] })}
        >
          <option value="small">{t('settings.fontSizeSmall')}</option>
          <option value="normal">{t('settings.fontSizeNormal')}</option>
          <option value="large">{t('settings.fontSizeLarge')}</option>
          <option value="xlarge">{t('settings.fontSizeXLarge')}</option>
        </select>
      </label>

      {/* The "show details" explanation lives in title: hover-only, so it costs no layout space */}
      <label className="check" title={t('settings.verboseHint')}>
        <input
          type="checkbox"
          checked={draft.verbose}
          onChange={(e) => patch({ verbose: e.target.checked })}
        />
        <span>{t('settings.verbose')}</span>
      </label>

      <div className="row actions">
        <button className="primary save" onClick={() => void handleSave()} disabled={saving}>
          {saving ? t('settings.saving') : t('settings.save')}
        </button>
        <button className="ghost" onClick={() => void handleTest()} disabled={probing}>
          {probing ? t('settings.testing') : t('settings.test')}
        </button>
        <button className="ghost" onClick={() => setDraft({ ...DEFAULT_SETTINGS })}>
          {t('settings.reset')}
        </button>
      </div>

      {/* API key / upstream URL / default model live in the backend; this is only the way in */}
      <button
        className="console-link"
        onClick={() => {
          const parsed = validated();
          if (!parsed) return;
          const base = parsed.origin + parsed.pathname.replace(/\/+$/, '');
          void browser.tabs.create({ url: `${base}/settings` });
        }}
      >
        <span>{t('settings.console')}</span>
        <small>{t('settings.consoleHint')}</small>
      </button>
      {probe && (
        <p className={probe.ok ? 'muted small' : 'err'}>
          {probe.ok ? t(probe.key, probe.params) : probe.text}
        </p>
      )}
    </section>
  );
}
