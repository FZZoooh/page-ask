import { memo } from 'react';
import Markdown, { type Components } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

const remarkPlugins = [remarkGfm, remarkMath, remarkBreaks];
const rehypePlugins = [[rehypeKatex, { throwOnError: false, strict: false, output: 'html' }]] as const;

/**
 * 只允许能安全打开的协议；`javascript:` / `data:` / `blob:` 一律降级成纯文本。
 * 相对链接按 https 解析后只保留 http(s)，所以也不会把侧栏导航到奇怪的地方。
 */
function safeHref(href: string | undefined): string | null {
  if (!href) return null;
  if (href.startsWith('#')) return href;
  try {
    const url = new URL(href, 'https://pageask.invalid');
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? href : null;
  } catch {
    return null;
  }
}

const components: Components = {
  // 所有链接都在新标签页打开：侧栏里点链接不应该把当前页面顶掉
  a: ({ href, children }) => {
    const safe = safeHref(href);
    if (!safe) return <span>{children}</span>;
    return (
      <a href={safe} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  },
  // 不自动加载远程图片：模型输出的 ![](https://…) 会泄露 IP/UA 并撑坏布局，
  // 这里只渲染成可点的文字链接。
  img: ({ src, alt }) => {
    const safe = typeof src === 'string' && /^https?:\/\//i.test(src) ? src : null;
    if (!safe) return <span>{alt ?? ''}</span>;
    return (
      <a href={safe} target="_blank" rel="noreferrer noopener">
        {alt || safe}
      </a>
    );
  },
  // 表格横向溢出时能滚
  table: ({ children }) => (
    <div className="table-wrap">
      <table>{children}</table>
    </div>
  ),
};

/**
 * 渲染一段 Markdown（含 GFM 表格、LaTeX 公式）。
 * memo：流式期间每 50ms 刷新一次，未变化的历史回答不应重跑 remark + KaTeX。
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
