import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { createPortal } from 'react-dom';
import Markdown, { type Components } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { splitStreamingMarkdown, normalizeDisplayMath } from '@/lib/markdown-stream.mjs';
import { t } from '@/lib/i18n';

// Keep the MathML annotation: it carries the original TeX, which the formula menu copies and quotes.
const remarkPlugins = [remarkGfm, remarkMath, remarkBreaks];
const rehypePlugins = [[rehypeKatex, { throwOnError: false, strict: false, output: 'htmlAndMathml' }]] as const;

const BaseUrlContext = createContext<string | undefined>(undefined);

/**
 * Allow only protocols that are safe to open; `javascript:` / `data:` / `blob:` fall back to plain text.
 * Relative links resolve against the page being read, so they open the real target rather than a fake host.
 */
function safeHref(href: string | undefined, baseUrl: string | undefined): string | null {
  if (!href) return null;
  if (href.startsWith('#')) return href;
  try {
    const url = new URL(href, baseUrl ?? 'https://pageask.invalid');
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

const components: Components = {
  // Open every link in a new tab: clicking one in the side panel must not replace the page being read
  a: ({ href, children }) => {
    const baseUrl = useContext(BaseUrlContext);
    const safe = safeHref(href, baseUrl);
    if (!safe) return <span>{children}</span>;
    return (
      <a href={safe} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  },
  // Don't auto-load remote images: a model-emitted ![](https://…) leaks IP/UA and wrecks the layout,
  // so render only a clickable text link here.
  img: ({ src, alt }) => {
    const safe = typeof src === 'string' && /^https?:\/\//i.test(src) ? src : null;
    if (!safe) return <span>{alt ?? ''}</span>;
    return (
      <a href={safe} target="_blank" rel="noreferrer noopener">
        {alt || safe}
      </a>
    );
  },
  // Let wide tables scroll instead of overflowing
  table: ({ children }) => (
    <div className="table-wrap">
      <table>{children}</table>
    </div>
  ),
};

/** Completed blocks are immutable while streaming, so memo prevents re-parsing earlier answers. */
const MarkdownBlock = memo(function MarkdownBlock({ text }: { text: string }) {
  // Normalize on the block (not inside splitStreamingMarkdown) so the unfinished plain-text tail
  // stays byte-for-byte what the model sent until it is complete.
  const source = useMemo(() => normalizeDisplayMath(text), [text]);
  return (
    <Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins as never} components={components}>
      {source}
    </Markdown>
  );
});

type MathMenu = { latex: string; display: boolean; x: number; y: number };

/**
 * Renders a Markdown block (GFM tables, LaTeX math).
 * While streaming, only completed blocks are parsed; the unfinished tail is plain text until a
 * blank line closes it. This keeps each block's remark/KaTeX work out of the next 50ms flush.
 */
export const MarkdownView = memo(function MarkdownView({
  text,
  streaming = false,
  baseUrl,
  onQuoteMath,
}: {
  text: string;
  streaming?: boolean;
  /** URL of the page being read; relative links in the answer resolve against it */
  baseUrl?: string;
  /** Insert a formula quote; the source keeps its `$…$` delimiters and the chip shows Unicode */
  onQuoteMath?: (source: string) => void;
}) {
  // Split both live and finished text with the same rules so the blocks parsed during streaming
  // keep their memo at completion; only the final tail needs a fresh parse.
  const split = useMemo(() => splitStreamingMarkdown(text), [text]);
  const [menu, setMenu] = useState<MathMenu | null>(null);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const closeTimer = useRef<number | null>(null);

  const closeMenu = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setMenu(null);
    setCopied(false);
  }, []);

  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) closeMenu();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeMenu();
      }
    };
    // The panel list scrolls under the fixed menu; keep it from floating over unrelated content.
    const onScroll = () => closeMenu();
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [menu, closeMenu]);

  const onContextMenu = (e: ReactMouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement | null;
    const katex = target?.closest('.katex');
    if (!katex || !e.currentTarget.contains(katex)) return;
    // rehype-katex keeps the original source in the MathML annotation, so no second parser is needed.
    const latex = katex.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim();
    if (!latex) return;
    e.preventDefault();
    e.stopPropagation();
    setCopied(false);
    setMenu({
      latex,
      display: Boolean(katex.closest('.katex-display')),
      x: e.clientX,
      y: e.clientY,
    });
  };

  const copyLatex = () => {
    if (!menu) return;
    void navigator.clipboard
      .writeText(menu.latex)
      .then(() => {
        setCopied(true);
        closeTimer.current = window.setTimeout(closeMenu, 800);
      })
      .catch(() => closeMenu());
  };

  const quoteLatex = () => {
    if (!menu) return;
    // Keep the delimiters as the math marker: editorDom turns this into a Unicode chip label and
    // serializes the original LaTeX back into <q>…</q> for the next request.
    const source = (menu.display ? '$$' : '$') + menu.latex + (menu.display ? '$$' : '$');
    closeMenu();
    onQuoteMath?.(source);
  };

  return (
    <BaseUrlContext.Provider value={baseUrl}>
      <div className="md" onContextMenu={onContextMenu}>
        {split.blocks.map((block, index) => (
          <MarkdownBlock key={index} text={block} />
        ))}
        {split.tail ? (
          streaming ? <span className="md-tail">{split.tail}</span> : <MarkdownBlock key="tail" text={split.tail} />
        ) : null}
      </div>
      {menu &&
        createPortal(
          <div
            ref={menuRef}
            className="math-menu"
            role="menu"
            aria-label={t('math.menu')}
            style={{
              left: Math.max(8, Math.min(menu.x, window.innerWidth - 168)),
              top: Math.max(8, Math.min(menu.y, window.innerHeight - 96)),
            }}
          >
            <button type="button" role="menuitem" autoFocus onClick={copyLatex}>
              {copied ? t('math.copied') : t('math.copy')}
            </button>
            {onQuoteMath && (
              <button type="button" role="menuitem" onClick={quoteLatex}>
                {t('math.quote')}
              </button>
            )}
          </div>,
          document.body,
        )}
    </BaseUrlContext.Provider>
  );
});
