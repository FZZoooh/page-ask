import { IconChevron } from '@/components/icons';
import { estimateTokens, type ExtractedPage } from '@/lib/extract';
import { t } from '@/lib/i18n';

interface PageCardProps {
  page: ExtractedPage;
  open: boolean;
  copied: boolean;
  onToggle: () => void;
  onCopy: () => void;
}

/** 页面卡片：默认只留一行，避免挤占对话空间 */
export function PageCard({ page, open, copied, onToggle, onCopy }: PageCardProps) {
  return (
    <section className="page">
      <button
        type="button"
        className="page-toggle"
        onClick={onToggle}
        title={open ? t('page.text.hide') : t('page.text')}
        aria-label={open ? t('page.text.hide') : t('page.text')}
        aria-expanded={open}
      >
        <span className="page-head">
          <span className="page-title" title={page.title}>
            {page.title || t('page.title.untitled')}
          </span>
          <span className="chev">
            <IconChevron open={open} />
          </span>
        </span>
        <span className="meta">
          <span>{page.site}</span>
          {page.kind === 'pdf' && page.pages ? (
            <span className="tag">{t('page.pdf', { pages: page.pages })}</span>
          ) : null}
          <span>{t('page.chars', { count: page.chars.toLocaleString() })}</span>
          <span>{t('page.tokens', { count: estimateTokens(page.chars).toLocaleString() })}</span>
          <span>{t('page.tookMS', { count: page.tookMs })}</span>
          {page.chars > 30000 && <span className="warn">{t('page.longWarning')}</span>}
        </span>
      </button>
      {open && (
        <>
          <div className="card-head">
            <span className="muted small">{t('page.text.title')}</span>
            <button className="ghost" onClick={onCopy}>
              {copied ? t('page.copied') : t('page.copy')}
            </button>
          </div>
          <pre className="preview">{page.markdown || t('page.text.empty')}</pre>
        </>
      )}
    </section>
  );
}
