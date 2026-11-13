import { useEffect, useRef, useState } from 'react';
import type { ClipboardEvent, DragEvent, FormEvent, KeyboardEvent, RefObject } from 'react';
import { IconSend, IconStop } from '@/components/icons';
import { hasTransferFiles, type DraftAttachment } from '@/lib/attachments';
import { t } from '@/lib/i18n';
import type { Settings } from '@/lib/settings';
import { AttachButton, AttachmentStrip, type PreviewTarget } from './AttachmentCards';

interface ComposerProps {
  editorRef: RefObject<HTMLDivElement | null>;
  settings: Settings | null;
  configured: boolean;
  pageReady: boolean;
  busy: boolean;
  canSend: boolean;
  /** Two-row layout: editor on top, attach + send on a bottom row */
  multiline: boolean;
  attachments: DraftAttachment[];
  uploading: boolean;
  /** Current page selection; an empty string means nothing is selected */
  selectionHint: string;
  onInput: (e: FormEvent<HTMLDivElement>) => void;
  onCompositionEnd: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
  onPaste: (e: ClipboardEvent<HTMLDivElement>) => void;
  onDrop: (e: DragEvent<HTMLDivElement>) => void;
  onAttach: (files: File[]) => void;
  onRemoveAttachment: (key: string) => void;
  onPreview: (target: PreviewTarget) => void;
  onSend: () => void;
  onExplainSelection: () => void;
  onStop: () => void;
}

/**
 * Composer: a pill on one line ("+" left, send right), switching to a rounded rectangle with the
 * buttons on their own bottom row once the text wraps or attachments are added.
 */
export function Composer({
  editorRef,
  settings,
  configured,
  pageReady,
  busy,
  canSend,
  multiline,
  attachments,
  uploading,
  selectionHint,
  onInput,
  onCompositionEnd,
  onKeyDown,
  onPaste,
  onDrop,
  onAttach,
  onRemoveAttachment,
  onPreview,
  onSend,
  onExplainSelection,
  onStop,
}: ComposerProps) {
  const placeholder = !configured
    ? t('composer.placeholder.noSettings')
    : !pageReady
      ? t('composer.placeholder.noPage')
      : t('composer.placeholder.ready');
  const canAttach = configured && pageReady;

  // :focus-visible cannot tell a pointer click from keyboard focus for contenteditable:
  // Chrome treats editable text as keyboard-editable and keeps the ring on mouse focus.
  // Track the last input modality ourselves so only Tab navigation paints the composer ring.
  const keyboardNav = useRef(false);
  const [keyboardRing, setKeyboardRing] = useState(false);
  const [dropping, setDropping] = useState(false);
  /** dragenter/dragleave fire for every child crossed, so count depth instead of trusting one event */
  const dragDepth = useRef(0);

  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Tab') keyboardNav.current = true;
    };
    const onPointerDown = () => {
      keyboardNav.current = false;
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, []);

  const boxClass = ['box', multiline && 'multi', keyboardRing && 'kb-focus', dropping && 'drop'].filter(Boolean).join(' ');

  return (
    <div
      className="composer"
      onDragEnter={(e) => {
        if (!canAttach || !hasTransferFiles(e.dataTransfer)) return;
        dragDepth.current += 1;
        setDropping(true);
      }}
      onDragOver={(e) => {
        // Without preventDefault the drop never fires (and the browser would navigate to the file)
        e.preventDefault();
        e.dataTransfer.dropEffect = !hasTransferFiles(e.dataTransfer) || canAttach ? 'copy' : 'none';
      }}
      onDragLeave={() => {
        if (dragDepth.current > 0 && --dragDepth.current === 0) setDropping(false);
      }}
      onDrop={(e) => {
        dragDepth.current = 0;
        setDropping(false);
        onDrop(e);
      }}
    >
      {selectionHint && (
        <div className="selection-actions">
          <button
            type="button"
            className="suggest"
            disabled={busy || uploading || !configured || !pageReady}
            onClick={onExplainSelection}
          >
            {t('composer.selection.explain')}
          </button>
        </div>
      )}
      <div
        className={boxClass}
        onFocusCapture={() => setKeyboardRing(keyboardNav.current)}
        onBlurCapture={() => setKeyboardRing(false)}
        onPointerDownCapture={() => {
          keyboardNav.current = false;
          setKeyboardRing(false);
        }}
      >
        <AttachmentStrip
          items={attachments}
          settings={settings}
          className="in-box"
          onRemove={onRemoveAttachment}
          onPreview={onPreview}
        />
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
            {/* Always one line: CSS truncates it, so a long selection cannot stretch the composer */}
            <span className="sel-hint-text">{selectionHint}</span>
          </div>
        )}
        <div
          ref={editorRef}
          className="editor"
          contentEditable={configured && pageReady}
          role="textbox"
          aria-multiline="true"
          aria-label={t('composer.inputAria')}
          suppressContentEditableWarning
          data-placeholder={placeholder}
          onInput={onInput}
          onCompositionEnd={onCompositionEnd}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <AttachButton className="attach-box" disabled={!canAttach} onFiles={onAttach} />
        {busy ? (
          <button className="send stop" onClick={onStop} title={t('composer.stop')} aria-label={t('composer.stop')}>
            <IconStop />
          </button>
        ) : (
          <button
            className="send"
            onClick={onSend}
            disabled={!canSend}
            title={uploading ? t('composer.uploading') : t('composer.send')}
            aria-label={t('composer.send')}
          >
            <IconSend />
          </button>
        )}
        {dropping && (
          <div className="drop-hint" aria-hidden="true">
            {t('composer.dropHint')}
          </div>
        )}
      </div>
    </div>
  );
}
