// PDF page-text extraction (Node side, server only).
//
// use the legacy pdfjs-dist build: no canvas dependency, text-layer parsing only,
// plus bundled CMaps / standard_fonts, so CJK (CID) fonts work.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PDFJS_ROOT = dirname(require.resolve('pdfjs-dist/package.json'));
const CMAP_URL = join(PDFJS_ROOT, 'cmaps') + '/';
const FONT_URL = join(PDFJS_ROOT, 'standard_fonts') + '/';

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

/** hard caps on pages and total chars, so one oversized PDF can't blow up memory/context */
export const MAX_PAGES = 400;
export const MAX_CHARS = 400_000;

export class PdfError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Extract text from a PDF byte stream.
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
      // never fetch fonts/CMaps over the network; the extension store wouldn't allow it either
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

/** join pdfjs text items into lines: break on hasEOL, undo end-of-line hyphenation */
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
    // the usual English line-break hyphenation: previous line ends in -, next starts lowercase
    const prev = out.at(-1);
    if (prev !== undefined && /[A-Za-z]-$/.test(prev) && /^[a-z]/.test(l)) {
      out[out.length - 1] = prev.slice(0, -1) + l;
      continue;
    }
    out.push(l);
  }
  return out.join('\n');
}

/** give each page a small heading, so the model can cite pages and the keyword search below works page by page */
function renderMarkdown(pages) {
  if (!pages.length) return '';
  if (pages.length === 1) return pages[0].text;
  return pages.map((p) => `\n\n### 第 ${p.n} 页\n\n${p.text}`).join('').trim();
}
