import { memo } from 'react';
import Markdown, { type Components } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

const remarkPlugins = [remarkGfm, remarkMath, remarkBreaks];
const rehypePlugins = [[rehypeKatex, { throwOnError: false, strict: false, output: 'html' }]] as const;

/**
 * Allow only protocols that are safe to open; `javascript:` / `data:` / `blob:` fall back to plain text.
 * Relative links resolve against https and keep only http(s), so they can't send the side panel anywhere odd.
 */
function safeHref(href: string | undefined): string | null {
  if (!href) return null;
  if (href.startsWith('#')) return href;
  try {
    const url = new URL(href, 'https://pageask.invalid');
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

const components: Components = {
  // Open every link in a new tab: clicking one in the side panel must not replace the page being read
  a: ({ href, children }) => {
    const safe = safeHref(href);
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

/**
 * Renders a Markdown block (GFM tables, LaTeX math).
 * memo: streaming re-renders every 50ms, so unchanged earlier answers must not re-run remark + KaTeX.
 */
export const MarkdownView = memo(function MarkdownView({ text }: { text: string }) {
  return (
    <div className="md">
      <Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins as never} components={components}>
        {text}
      </Markdown>
    </div>
  );
});
