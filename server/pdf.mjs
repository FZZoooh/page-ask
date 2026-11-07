// PDF 正文抽取（Node 侧，只在服务端跑）。
//
// 用 pdfjs-dist 的 legacy 构建：它不依赖 canvas，只做文本层解析，
// 并且自带 CMaps / standard_fonts，能处理中文这类 CID 字体。
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PDFJS_ROOT = dirname(require.resolve('pdfjs-dist/package.json'));
const CMAP_URL = join(PDFJS_ROOT, 'cmaps') + '/';
const FONT_URL = join(PDFJS_ROOT, 'standard_fonts') + '/';

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

/** 硬上限：页数与总字数，防止一个超大 PDF 把内存/上下文打爆 */
export const MAX_PAGES = 400;
export const MAX_CHARS = 400_000;

export class PdfError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * 从 PDF 字节流里抽文本。
 * @param {Uint8Array} bytes
 * @param {{maxPages?: number, maxChars?: number, onProgress?: (done:number,total:number)=>void}} [opts]
 * @returns {Promise<{pageCount:number, pages:Array<{n:number,text:string}>, text:string, chars:number, truncated:boolean}>}
 */
export async function extractPdfText(bytes, opts = {}) {
  const maxPages = opts.maxPages ?? MAX_PAGES;
  const maxChars = opts.maxChars ?? MAX_CHARS;

  let doc;
  let loadingTask;
  try {
    loadingTask = pdfjs.getDocument({
      data: bytes,
      cMapUrl: CMAP_URL,
      cMapPacked: true,
      standardFontDataUrl: FONT_URL,
      // 不要回源到网络取字体/CMap；扩展商店里也不会允许
      useSystemFonts: false,
      isEvalSupported: false,
      verbosity: 0,
    });
    doc = await loadingTask.promise;
  } catch (err) {
    throw new PdfError('bad_pdf', `PDF 解析失败：${err?.message ?? err}`);
  }

  const pageCount = doc.numPages;
  const pages = [];
  let chars = 0;
  let truncated = false;

  try {
    const limit = Math.min(pageCount, maxPages);
    for (let n = 1; n <= limit; n++) {
      if (chars >= maxChars) {
        truncated = true;
        break;
      }
      let text = '';
      try {
        const page = await doc.getPage(n);
        const content = await page.getTextContent();
        text = joinTextItems(content.items);
        page.cleanup();
      } catch (err) {
        text = `（第 ${n} 页解析失败：${err?.message ?? err}）`;
      }
      if (text) {
        chars += text.length;
        pages.push({ n, text });
      }
      opts.onProgress?.(n, limit);
    }
    if (limit < pageCount) truncated = true;
  } finally {
    await loadingTask.destroy().catch(() => {});
  }

  const text = renderMarkdown(pages).slice(0, maxChars);
  return { pageCount, pages, text, chars: text.length, truncated };
}

/** 把 pdfjs 的 text items 拼成行文本：按 hasEOL 断行，去掉行尾连字符断词 */
function joinTextItems(items) {
  const lines = [];
  let line = '';
  for (const item of items) {
    const str = item.str ?? '';
    if (!str) {
      if (item.hasEOL) {
        lines.push(line);
        line = '';
      }
      continue;
    }
    line += str;
    if (item.hasEOL) {
      lines.push(line);
      line = '';
    }
  }
  if (line) lines.push(line);

  const out = [];
  for (const raw of lines) {
    const l = raw.replace(/[ \t\u00a0]+/g, ' ').trim();
    if (!l) continue;
    // 英文排版常见的行尾断词：上一行以 - 结尾、下一行小写开头
    const prev = out.at(-1);
    if (prev !== undefined && /[A-Za-z]-$/.test(prev) && /^[a-z]/.test(l)) {
      out[out.length - 1] = prev.slice(0, -1) + l;
      continue;
    }
    out.push(l);
  }
  return out.join('\n');
}

/** 每页加一个小标题，方便模型按页引用，也方便下面按页做「搜关键词」 */
function renderMarkdown(pages) {
  if (!pages.length) return '';
  if (pages.length === 1) return pages[0].text;
  return pages.map((p) => `\n\n### 第 ${p.n} 页\n\n${p.text}`).join('').trim();
}
