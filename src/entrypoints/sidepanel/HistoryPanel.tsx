import type { ConversationMeta } from '@/lib/chat';
import { t } from '@/lib/i18n';
import { fmtTime } from './messages';

interface HistoryPanelProps {
  conversations: ConversationMeta[];
  conversationId: string | null;
  busy: boolean;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}

export function HistoryPanel({ conversations, conversationId, busy, onOpen, onDelete }: HistoryPanelProps) {
  return (
    <section className="card convs">
      <div className="card-head">
        <span className="muted small">{t('history.hint')}</span>
      </div>
      {conversations.length === 0 && <p className="muted small">{t('history.empty')}</p>}
      {conversations.map((c) => (
        <div key={c.id} className={`conv ${c.id === conversationId ? 'on' : ''}`}>
          <button className="conv-main" onClick={() => onOpen(c.id)} disabled={busy}>
            <span className="conv-t">{c.title || c.lastUserText || t('history.untitled')}</span>
            <span className="conv-m">
              {fmtTime(c.lastMessageAt ?? c.updatedAt)} {t('history.count', { count: c.messageCount ?? 0 })}
            </span>
          </button>
          <button
            className="conv-del"
            title={t('history.delete')}
            aria-label={t('history.delete')}
            onClick={() => onDelete(c.id)}
            disabled={busy}
          >
            ×
          </button>
        </div>
      ))}
    </section>
  );
}
