import { createContext, memo, useContext, useMemo } from 'react';
import Markdown, { type Components } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { splitStreamingMarkdown } from '@/lib/markdown-stream.mjs';

const remarkPlugins = [remarkGfm, remarkMath, remarkBreaks];
const rehypePlugins = [[rehypeKatex, { throwOnError: false, strict: false, output: 'html' }]] as const;

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
  return (
    <Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins as never} components={components}>
      {text}
    </Markdown>
  );
});

/**
 * Renders a Markdown block (GFM tables, LaTeX math).
 * While streaming, only completed blocks are parsed; the unfinished tail is plain text until a
 * blank line closes it. This keeps each block's remark/KaTeX work out of the next 50ms flush.
 */
export const MarkdownView = memo(function MarkdownView({
  text,
  streaming = false,
  baseUrl,
}: {
  text: string;
  streaming?: boolean;
  /** URL of the page being read; relative links in the answer resolve against it */
  baseUrl?: string;
}) {
  const split = useMemo(
    () => (streaming ? splitStreamingMarkdown(text) : { blocks: [text], tail: '' }),
    [streaming, text],
  );

  if (!streaming) {
    return (
      <BaseUrlContext.Provider value={baseUrl}>
        <div className="md">
          <Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins as never} components={components}>
            {text}
          </Markdown>
        </div>
      </BaseUrlContext.Provider>
    );
  }

  return (
    <BaseUrlContext.Provider value={baseUrl}>
      <div className="md">
        {split.blocks.map((block, index) => (
          <MarkdownBlock key={index} text={block} />
        ))}
        {split.tail ? <span className="md-tail">{split.tail}</span> : null}
      </div>
    </BaseUrlContext.Provider>
  );
});
