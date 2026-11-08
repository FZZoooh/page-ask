import { Component, type ErrorInfo, type ReactNode } from 'react';
import { t } from '@/lib/i18n';

/**
 * Last-resort UI: a render crash in any panel component would otherwise leave a blank side panel
 * with no way back except closing it. The fallback keeps the extension usable via a reload.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[pageask] side panel render failed', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="fatal" role="alert">
        <h1>{t('app.renderError')}</h1>
        <p>{t('app.renderErrorHint')}</p>
        <button type="button" className="fatal-reload" onClick={() => window.location.reload()}>
          {t('app.reload')}
        </button>
      </div>
    );
  }
}
