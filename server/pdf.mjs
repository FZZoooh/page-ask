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
 * Clamp caller-provided limits to the hard caps. The HTTP layer passes request values straight through,
 * so without this a caller could ask for 1e9 pages/characters and pin the CPU on one PDF.
 */
export function normalizePdfLimits(opts = {}) {
  const pick = (value, fallback, max) => {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n) || n < 1) return fallback;
    return Math.min(Math.floor(n), max);
  };
  return {
    maxPages: pick(opts.maxPages, MAX_PAGES, MAX_PAGES),
    maxChars: pick(opts.maxChars, MAX_CHARS, MAX_CHARS),
  };
}

/**
 * Extract text from a PDF byte stream.
 * @param {Uint8Array} bytes
 * @param {{maxPages?: number, maxChars?: number, onProgress?: (done:number,total:number)=>void, signal?: AbortSignal}} [opts]
 * @returns {Promise<{pageCount:number, pages:Array<{n:number,text:string}>, text:string, chars:number, truncated:boolean}>}
 */
export async function extractPdfText(bytes, opts = {}) {
  const { maxPages, maxChars } = normalizePdfLimits(opts);
  const cancelled = () => new PdfError('cancelled', 'PDF parsing cancelled');
  const throwIfCancelled = () => {
    if (opts.signal?.aborted) throw cancelled();
  };

  throwIfCancelled();
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
    throw new PdfError('bad_pdf', `Failed to parse PDF: ${err?.message ?? err}`);
  }

  const pageCount = doc.numPages;
  const pages = [];
  let chars = 0;
  let truncated = false;

  try {
    const limit = Math.min(pageCount, maxPages);
    for (let n = 1; n <= limit; n++) {
      throwIfCancelled();
      if (chars >= maxChars) {
        truncated = true;
        break;
      }
      let text = '';
      let page;
      try {
        page = await doc.getPage(n);
        throwIfCancelled();
        const content = await page.getTextContent();
        text = joinTextItems(content.items);
      } catch (err) {
        // A Stop/timeout during getPage/getTextContent is cancellation, not a broken page.
        if (opts.signal?.aborted) throw cancelled();
        text = `(Page ${n} failed to parse: ${err?.message ?? err})`;
      } finally {
        try {
          page?.cleanup();
        } catch {
          /* cleanup is best-effort; a failed page must not mask cancellation */
        }
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
  return pages.map((p) => `\n\n### Page ${p.n}\n\n${p.text}`).join('').trim();
}
