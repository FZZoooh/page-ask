import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
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

interface DeleteConfirmDialogProps {
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

function DeleteConfirmDialog({ busy, onCancel, onConfirm }: DeleteConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement;
    cancelRef.current?.focus();
    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== 'Tab') return;

    const buttons = dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
    if (!buttons?.length) return;
    const first = buttons[0]!;
    const last = buttons[buttons.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      className="confirm-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
      onKeyDown={onKeyDown}
    >
      <div
        ref={dialogRef}
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="history-delete-title"
        aria-describedby="history-delete-description"
      >
        <h2 id="history-delete-title">{t('history.delete')}</h2>
        <p id="history-delete-description">{t('history.deleteConfirm')}</p>
        <div className="confirm-actions">
          <button ref={cancelRef} type="button" className="confirm-cancel" onClick={onCancel}>
            {t('history.deleteCancel')}
          </button>
          <button type="button" className="confirm-danger" onClick={onConfirm} disabled={busy}>
            {t('history.deleteAction')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function HistoryPanel({ conversations, conversationId, busy, onOpen, onDelete }: HistoryPanelProps) {
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const closeDelete = useCallback(() => setPendingDelete(null), []);

  const confirmDelete = () => {
    if (pendingDelete === null || busy) return;
    onDelete(pendingDelete);
    closeDelete();
  };

  return (
    <>
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
              onClick={() => setPendingDelete(c.id)}
              disabled={busy}
            >
              ×
            </button>
          </div>
        ))}
      </section>
      {pendingDelete !== null && (
        <DeleteConfirmDialog busy={busy} onCancel={closeDelete} onConfirm={confirmDelete} />
      )}
    </>
  );
}
