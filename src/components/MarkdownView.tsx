import Markdown, { type Components } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

const remarkPlugins = [remarkGfm, remarkMath, remarkBreaks];
const rehypePlugins = [[rehypeKatex, { throwOnError: false, strict: false, output: 'html' }]] as const;

const components: Components = {
  // 所有链接都在新标签页打开：侧栏里点链接不应该把当前页面顶掉
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
  // 表格横向溢出时能滚
  table: ({ children }) => (
    <div className="table-wrap">
      <table>{children}</table>
    </div>
  ),
};

/** 渲染一段 Markdown（含 GFM 表格、LaTeX 公式）。 */
export function MarkdownView({ text }: { text: string }) {
  return (
    <div className="md">
      <Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins as never} components={components}>
        {text}
      </Markdown>
    </div>
  );
}
