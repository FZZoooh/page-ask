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

export function SettingsPanel({ value, onDone, onClose }: Props) {
  const [draft, setDraft] = useState<Settings>(value);
  const [saving, setSaving] = useState(false);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [probing, setProbing] = useState(false);

  const patch = (p: Partial<Settings>) => setDraft((d) => ({ ...d, ...p }));

  const normalized = (): Settings => ({
    backendUrl: draft.backendUrl.trim() || DEFAULT_SETTINGS.backendUrl,
    verbose: draft.verbose,
    token: draft.token.trim(),
  });

  const handleSave = async () => {
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

      {/* 「显示详细信息」的说明放在 title 里，悬停才出现，不占版面 */}
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

      {/* API Key / 上游地址 / 默认模型在后端，这里只给一个入口 */}
      <button
        className="console-link"
        onClick={() => {
          const url = `${normalized().backendUrl.replace(/\/+$/, '')}/settings`;
          void browser.tabs.create({ url });
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
