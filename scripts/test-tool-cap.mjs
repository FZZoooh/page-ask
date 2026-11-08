// Regression: RESULT_CAP is a cap on the final model-facing string, including the untrusted envelope
// and page-controlled attributes. A huge title or body must never push it past 8000. Run:
// node scripts/test-tool-cap.mjs
import { runTool } from '../server/tools.mjs';

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !extra ? '' : ` — ${extra}`}`);
  if (!ok) failures += 1;
};

const page = {
  url: `https://example.com/${'u'.repeat(4000)}`,
  title: `<${'t'.repeat(20000)}`,
  markdown: '正文'.repeat(20000),
  kind: 'web',
};

const out = await runTool('read_page', { limit: 8000 }, { page });
check('结果仍是 untrusted 信封', out.text.startsWith('<untrusted_content '), out.text.slice(0, 120));
check('信封正确闭合', out.text.endsWith('</untrusted_content>'), out.text.slice(-80));
check('最终长度不超过 RESULT_CAP', out.text.length <= 8000, String(out.text.length));
check('截断标记在信封内', out.text.includes('[Truncated: output limited to 8000 chars'), String(out.text.length));
check('关闭标签没有出现在正文中', out.text.indexOf('</untrusted_content>') === out.text.length - '</untrusted_content>'.length, String(out.text.indexOf('</untrusted_content>')));

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exitCode = failures ? 1 : 0;
