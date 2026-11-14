import { lazy, memo, Suspense, useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconArtifactFile, IconClose, IconDownload, IconQuote } from './icons';
import { buildArtifactPreview, fetchArtifact, type ArtifactContext, type ArtifactPreviewContent } from '@/lib/artifacts';
import { t } from '@/lib/i18n';

// Defer the dependency to avoid a Card -> MarkdownView -> Card import cycle.
const MarkdownPreview = lazy(() => import('./MarkdownView').then(({ MarkdownView }) => ({ default: MarkdownView })));

function ArtifactPreview({ name, content, restoreFocus, onClose }: {
  name: string;
  content: ArtifactPreviewContent;
  restoreFocus: HTMLElement | null;
  onClose: () => void;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const previousFocus = restoreFocus ?? document.activeElement;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      } else if (event.key === 'Tab') {
        const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], summary, [tabindex]:not([tabindex="-1"])',
        ) ?? []);
        const first = controls[0];
        const last = controls[controls.length - 1];
        const active = document.activeElement;
        if (event.shiftKey && (active === first || !dialogRef.current?.contains(active))) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && (active === last || !dialogRef.current?.contains(active))) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    const keepFocus = () => {
      if (!dialogRef.current?.contains(document.activeElement) || document.activeElement === frameRef.current) {
        closeRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', keepFocus, true);
    window.addEventListener('blur', keepFocus);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', keepFocus, true);
      window.removeEventListener('blur', keepFocus);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, [onClose, restoreFocus]);

  return createPortal(
    <div
      className="artifact-overlay"
      onClick={(event) => {
        // React portals bubble synthetic clicks through the component tree, not the DOM tree:
        // without this stop, a close/backdrop click would re-trigger the card's preview onClick.
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={`artifact-dialog${content.kind !== 'markdown' ? ` ${content.kind}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="artifact-dialog-head">
          <span id={titleId} className="artifact-name" title={name}>{name}</span>
          <button
            ref={closeRef}
            type="button"
            className="artifact-close"
            onClick={onClose}
            title={t('artifact.close')}
            aria-label={t('artifact.close')}
          >
            <IconClose />
          </button>
        </div>
        {content.kind === 'html' ? (
          <iframe
            ref={frameRef}
            className="artifact-frame"
            title={t('artifact.previewTitle', { name })}
            sandbox=""
            referrerPolicy="no-referrer"
            tabIndex={-1}
            onFocus={() => closeRef.current?.focus()}
            srcDoc={content.source}
          />
        ) : (
          // Code and table previews scroll inside their content block (both axes), so the body is
          // not a scroll container there and keyboard focus moves to that block instead.
          <div
            className="artifact-preview-body"
            tabIndex={content.kind === 'markdown' ? 0 : undefined}
            aria-label={content.kind === 'markdown' ? t('artifact.previewTitle', { name }) : undefined}
          >
            {content.kind === 'markdown' && (
              <Suspense fallback={<div className="artifact-preview-notice">{t('artifact.loading')}</div>}>
                <MarkdownPreview text={content.source} />
              </Suspense>
            )}
            {content.kind === 'code' && (
              <>
                {content.limited && <div className="artifact-preview-notice">{t('artifact.highlightLimited')}</div>}
                <pre className="artifact-code" tabIndex={0} aria-label={t('artifact.previewTitle', { name })}><code>
                  {content.highlighted !== null && <span dangerouslySetInnerHTML={{ __html: content.highlighted }} />}
                  {content.source}
                </code></pre>
              </>
            )}
            {content.kind === 'table' && (
              <>
                {content.truncated && <div className="artifact-preview-notice">{t('artifact.tableLimited')}</div>}
                {content.headers.length ? (
                  <div className="md artifact-table" tabIndex={0} aria-label={t('artifact.previewTitle', { name })}>
                    <div className="table-wrap">
                      <table>
                        <thead><tr>{content.headers.map((cell, column) => <th key={column}>{cell}</th>)}</tr></thead>
                        <tbody>{content.rows.map((row, index) => (
                          <tr key={index}>{row.map((cell, column) => <td key={column}>{cell}</td>)}</tr>
                        ))}</tbody>
                      </table>
                    </div>
                  </div>
                ) : <div className="artifact-preview-notice">{t('artifact.empty')}</div>}
              </>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

export const ArtifactCard = memo(function ArtifactCard({ name, artifacts }: { name: string; artifacts: ArtifactContext }) {
  const { settings, conversationId, showToast, quoteFile } = artifacts;
  const fileKey = JSON.stringify([settings.backendUrl, settings.token, conversationId, name]);
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState<{ key: string; status: 'checking' | 'ready' | 'unavailable' }>({
    key: fileKey, status: 'checking',
  });
  const [preview, setPreview] = useState<{ key: string; content: ArtifactPreviewContent } | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const urlsRef = useRef(new Map<string, number>());
  const closePreview = useCallback(() => setPreview(null), []);
  const extension = name.slice(name.lastIndexOf('.') + 1).toUpperCase();
  const status = check.key === fileKey ? check.status : 'checking';

  useEffect(() => {
    const controller = new AbortController();
    setCheck({ key: fileKey, status: 'checking' });
    setPreview(null);
    setBusy(false);
    void fetchArtifact(artifacts, name, controller.signal).then(() => {
      if (!controller.signal.aborted) setCheck({ key: fileKey, status: 'ready' });
    }).catch(() => {
      if (!controller.signal.aborted) setCheck({ key: fileKey, status: 'unavailable' });
    });
    return () => {
      controller.abort();
      requestRef.current?.abort();
      requestRef.current = null;
      for (const [url, timer] of urlsRef.current) {
        window.clearTimeout(timer);
        URL.revokeObjectURL(url);
      }
      urlsRef.current.clear();
    };
  }, [fileKey]);

  const open = async (action: 'download' | 'preview', opener: HTMLElement) => {
    if (requestRef.current || status !== 'ready') return;
    // Disabling a loading button can blur it before the modal mounts; remember the actual trigger.
    openerRef.current = opener;
    const controller = new AbortController();
    requestRef.current = controller;
    setBusy(true);
    try {
      const blob = await fetchArtifact(artifacts, name, controller.signal);
      if (controller.signal.aborted) return;
      if (action === 'preview') {
        const text = await blob.text();
        if (controller.signal.aborted) return;
        const content = await buildArtifactPreview(name, text);
        if (!controller.signal.aborted) setPreview({ key: fileKey, content });
      } else {
        // Do not use the endpoint URL as an anchor: it needs Authorization and serves opaque bytes.
        const url = URL.createObjectURL(new Blob([blob], { type: 'application/octet-stream' }));
        const timer = window.setTimeout(() => {
          URL.revokeObjectURL(url);
          urlsRef.current.delete(url);
        }, 1000);
        urlsRef.current.set(url, timer);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = name;
        document.body.append(anchor);
        try {
          anchor.click();
        } finally {
          anchor.remove();
        }
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        showToast(cause instanceof SyntaxError ? t('artifact.invalidTable') :
          cause instanceof Error ? cause.message : t('error.unknown'));
      }
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setBusy(false);
      }
    }
  };

  return (
    <div
      className={`artifact-card ${status}`}
      aria-busy={busy || status === 'checking'}
      // The card itself opens the preview; only announce it as a button while that action can run.
      role={status === 'ready' ? 'button' : undefined}
      tabIndex={status === 'ready' ? 0 : undefined}
      aria-disabled={status === 'ready' && busy ? true : undefined}
      aria-label={status === 'ready' ? t('artifact.previewTitle', { name }) : undefined}
      title={status === 'ready' ? t('artifact.previewTitle', { name }) : undefined}
      onClick={(event) => void open('preview', event.currentTarget)}
      onKeyDown={(event) => {
        // Key events bubble from the nested action buttons; preview only when the card itself is focused.
        if (event.target !== event.currentTarget) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        void open('preview', event.currentTarget);
      }}
    >
      <div className="artifact-card-row">
        <span className="artifact-icon" aria-hidden="true"><IconArtifactFile extension={extension} /></span>
        <div className="artifact-info">
          <span className="artifact-name" title={name}>{name}</span>
          <span className="artifact-type" role="status">
            {status === 'checking' ? t('artifact.checking') : status === 'unavailable' ? t('artifact.unavailable') :
              busy ? t('artifact.loading') : extension}
          </span>
        </div>
        <div className="artifact-actions">
          <button
            type="button"
            className="artifact-action"
            onClick={(event) => {
              event.stopPropagation();
              quoteFile(name);
            }}
            title={t('artifact.quote')}
            aria-label={t('artifact.quote')}
          >
            <IconQuote />
          </button>
          <button
            type="button"
            className="artifact-action"
            disabled={busy || status !== 'ready'}
            onClick={(event) => {
              event.stopPropagation();
              void open('download', event.currentTarget);
            }}
            title={t('artifact.download')}
            aria-label={t('artifact.download')}
          >
            <IconDownload />
          </button>
        </div>
      </div>
      {preview?.key === fileKey && (
        <ArtifactPreview name={name} content={preview.content} restoreFocus={openerRef.current} onClose={closePreview} />
      )}
    </div>
  );
});
