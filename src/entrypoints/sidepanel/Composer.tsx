import type { ClipboardEvent, KeyboardEvent, RefObject } from 'react';
import { IconSend, IconStop } from '@/components/icons';
import { t } from '@/lib/i18n';

interface ComposerProps {
  editorRef: RefObject<HTMLDivElement | null>;
  configured: boolean;
  pageReady: boolean;
  busy: boolean;
  canSend: boolean;
  /** 当前网页选区；空串表示没有选区 */
  selectionHint: string;
  onInput: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
  onPaste: (e: ClipboardEvent<HTMLDivElement>) => void;
  onSend: () => void;
  onStop: () => void;
}

/** 输入区：单行是胶囊，多行平滑长成圆角矩形 */
export function Composer({
  editorRef,
  configured,
  pageReady,
  busy,
  canSend,
  selectionHint,
  onInput,
  onKeyDown,
  onPaste,
  onSend,
  onStop,
}: ComposerProps) {
  const placeholder = !configured
    ? t('composer.placeholder.noSettings')
    : !pageReady
      ? t('composer.placeholder.noPage')
      : t('composer.placeholder.ready');

  return (
    <div className="composer">
      <div className="box">
        {selectionHint && (
          <div
            className="sel-hint"
            role="note"
            title={selectionHint}
            aria-label={t('composer.selection.aria', { text: selectionHint })}
          >
            <span className="sel-hint-mark" aria-hidden="true">
              ❝
            </span>
            {/* 永远单行：CSS 截断，长选区不撑高输入框 */}
            <span className="sel-hint-text">{selectionHint}</span>
          </div>
        )}
        <div
          ref={editorRef}
          className="editor"
          contentEditable={configured && pageReady}
          role="textbox"
          aria-multiline="true"
          aria-label={placeholder}
          suppressContentEditableWarning
          data-placeholder={placeholder}
          onInput={onInput}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        {busy ? (
          <button className="send stop" onClick={onStop} title={t('composer.stop')} aria-label={t('composer.stop')}>
            <IconStop />
          </button>
        ) : (
          <button
            className="send"
            onClick={onSend}
            disabled={!canSend}
            title={t('composer.send')}
            aria-label={t('composer.send')}
          >
            <IconSend />
          </button>
        )}
      </div>
    </div>
  );
}
