import { useEffect, useRef, useState } from 'react';
import type { ClipboardEvent, DragEvent, FormEvent, KeyboardEvent, RefObject } from 'react';
import { IconSend, IconStop } from '@/components/icons';
import { t } from '@/lib/i18n';

interface ComposerProps {
  editorRef: RefObject<HTMLDivElement | null>;
  configured: boolean;
  pageReady: boolean;
  busy: boolean;
  canSend: boolean;
  /** Current page selection; an empty string means nothing is selected */
  selectionHint: string;
  onInput: (e: FormEvent<HTMLDivElement>) => void;
  onCompositionEnd: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
  onPaste: (e: ClipboardEvent<HTMLDivElement>) => void;
  onDrop: (e: DragEvent<HTMLDivElement>) => void;
  onSend: () => void;
  onStop: () => void;
}

/** Composer: a pill on one line, growing smoothly into a rounded rectangle as it fills */
export function Composer({
  editorRef,
  configured,
  pageReady,
  busy,
  canSend,
  selectionHint,
  onInput,
  onCompositionEnd,
  onKeyDown,
  onPaste,
  onDrop,
  onSend,
  onStop,
}: ComposerProps) {
  const placeholder = !configured
    ? t('composer.placeholder.noSettings')
    : !pageReady
      ? t('composer.placeholder.noPage')
      : t('composer.placeholder.ready');

  // :focus-visible cannot tell a pointer click from keyboard focus for contenteditable:
  // Chrome treats editable text as keyboard-editable and keeps the ring on mouse focus.
  // Track the last input modality ourselves so only Tab navigation paints the composer ring.
  const keyboardNav = useRef(false);
  const [keyboardRing, setKeyboardRing] = useState(false);

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

  return (
    <div className="composer">
      <div
        className={keyboardRing ? 'box kb-focus' : 'box'}
        onFocusCapture={() => setKeyboardRing(keyboardNav.current)}
        onBlurCapture={() => setKeyboardRing(false)}
        onPointerDownCapture={() => {
          keyboardNav.current = false;
          setKeyboardRing(false);
        }}
      >
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
          onDragOver={(e) => e.preventDefault()}
          onDrop={onDrop}
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
