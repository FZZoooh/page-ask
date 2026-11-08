// Tool implementations for PageAsk: read_page, screenshot, web_search, fetch_url.
// All tools are read-only. External content is encapsulated in <untrusted_content>
// blocks and hard-capped at RESULT_CAP characters to prevent context overflow.

import { assertPublicHttpUrl, readBodyCapped } from './net.mjs';
import { extractPdfText } from './pdf.mjs';
import { findParagraphs } from './text.mjs';
import { withV1 } from './upstream.mjs';

export const RESULT_CAP = 8000;

/** Tool definitions conforming to OpenAI function calling specifications */
export const TOOL_SPECS = [
  {
    type: 'function',
    function: {
      name: 'read_page',
      description:
        'Reads markdown content from the active browser tab. ' +
        'Supports offset/limit pagination for long documents, and keyword search via query. ' +
        'Set scope="viewport" to read only the currently visible screen area. ' +
        'Note: PDF documents lack DOM structure and do not support viewport reads. ' +
        'For PDFs, use screenshot for visual inspection, or query/offset for text extraction.',
      parameters: {
        type: 'object',
        properties: {
          scope: {
            type: 'string',
            enum: ['page', 'viewport'],
            description: 'Optional. "page" for entire document (default); "viewport" for currently visible area.',
          },
          query: {
            type: 'string',
            description: 'Optional. Keyword filter; returns only matching paragraphs.',
          },
          offset: { type: 'integer', description: 'Optional. Zero-based character offset (default: 0).' },
          limit: { type: 'integer', description: 'Optional. Maximum characters to read (default: 4000, max: 8000).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'screenshot',
      description:
        'Captures the visible browser viewport as an image. ' +
        'Recommended for charts, layouts, UI elements, or scanned documents. ' +
        'Note: Captures the viewport state at the time the request was initiated.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Performs a web search for real-time, external, or reference information. ' +
        'Supports standard search operators (site:, -site:, lang:, after:, before:, and exact quotes).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query string (1-128 characters).' },
          count: { type: 'integer', description: 'Result count (1-10, default: 5).' },
          need_content: {
            type: 'boolean',
            description: 'Whether to include full page content in results. Default is false; prefer fetch_url for full text.',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Fetches and parses a web page or PDF document by URL, returning Markdown text.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Target HTTP/HTTPS URL.' },
        },
        required: ['url'],
      },
    },
  },
];

/** Flattened tool definitions for Responses API compatibility */
export const RESPONSES_TOOLS = TOOL_SPECS.map((t) => ({
  type: 'function',
  name: t.function.name,
  description: t.function.description,
  parameters: t.function.parameters,
}));

/**
 * Dispatches and executes a tool invocation.
 * @returns {Promise<{ text: string, label: string, detail: string, failed?: boolean, imageData?: string }>}
 */
export async function runTool(name, args, ctx) {
  switch (name) {
    case 'read_page':
      return readPage(args, ctx);
    case 'web_search':
      return webSearch(args, ctx);
    case 'fetch_url':
      return fetchUrl(args, ctx);
    case 'screenshot':
      return screenshot(args, ctx);
    default:
      return {
        text: `Unknown tool "${name}". Supported tools: read_page, web_search, fetch_url, screenshot.`,
        label: name,
        detail: 'Unknown tool',
      };
  }
}

/* ---------------- screenshot ---------------- */

function screenshot(_args, { page }) {
  if (!page?.screenshot) {
    return {
      text: 'Screenshot capture unavailable for this tab (browser internal page or permissions denied). Fall back to read_page.',
      label: 'Screenshot',
      detail: 'Capture unavailable',
      failed: true,
    };
  }

  return {
    text: 'Viewport screenshot attached. Answer directly based on the visual content without unnecessary preamble.',
    label: 'Screenshot',
    detail: `${page.screenshotWidth ?? '?'}x${page.screenshotHeight ?? '?'} px`,
    imageData: page.screenshot,
  };
}

/* ---------------- read_page ---------------- */

function readPage(args, { page }) {
  const scope = args?.scope === 'viewport' ? 'viewport' : 'page';
  const isPdfPage = page?.kind === 'pdf';

  if (scope === 'viewport' && isPdfPage) {
    return {
      text: 'PDF documents do not expose DOM structures; viewport extraction is unsupported. Use screenshot for visual rendering, or use read_page with query/offset/limit for text content.',
      label: 'Read Page',
      detail: 'Viewport unsupported on PDF',
      failed: true,
    };
  }

  if (scope === 'viewport') {
    const v = page?.viewport;
    const visible = (v?.text ?? '').trim();
    if (!visible) {
      return {
        text: 'Visible viewport contains no readable text. Fall back to read_page for full document extraction, or screenshot for visual inspection.',
        label: 'Read Page',
        detail: 'Empty viewport',
        failed: true,
      };
    }
    const pct = v?.scrollHeight && v.scrollHeight > v.height + 40
      ? Math.round((v.scrollY / (v.scrollHeight - v.height)) * 100)
      : 0;
    const header = `(Viewport position: scrollY=${v?.scrollY ?? 0}px, height=${v?.height ?? 0}px, approx. ${pct}% down page)\n\n`;
    return {
      text: wrap(page, cap(header + visible, 'Viewport content exceeded limit and was truncated.')),
      label: 'Read Page',
      detail: `Viewport: ${visible.length} chars`,
    };
  }

  const body = page?.markdown ?? '';
  const total = body.length;
  const isPdf = page?.kind === 'pdf';
  const pdfPages = page?.pages ? ` · ${page.pages} pages total` : '';

  if (!total) {
    return {
      text: isPdf
        ? 'No extractable text layer found in PDF (likely scanned or image-only). Use screenshot for visual inspection.'
        : 'Page content is empty (content unrendered or document has no text).',
      label: isPdf ? 'Read PDF' : 'Read Page',
      detail: isPdf ? 'No text layer' : 'Empty content',
      failed: isPdf ? true : undefined,
    };
  }

  const query = typeof args?.query === 'string' ? args.query.trim() : '';
  if (query) {
    const hits = findParagraphs(body, query, 12);
    const detail = `Search ${isPdf ? 'PDF' : 'page'}: "${query}"`;
    if (!hits.length) {
      return {
        text: wrap(page, `No paragraphs matching "${query}" found (${total} chars${pdfPages}). Consider searching without query or using alternative keywords.`),
        label: isPdf ? 'Read PDF' : 'Read Page',
        detail,
      };
    }

    const queryLimit = Math.min(
      Math.max(Number.isFinite(args?.limit) ? Math.trunc(args.limit) : 4000, 200),
      RESULT_CAP,
    );
    let text = `Found ${hits.length} paragraph(s) matching "${query}" in ${isPdf ? 'PDF' : 'page'}:\n\n` + hits.join('\n\n');
    if (text.length > queryLimit) {
      text =
        text.slice(0, queryLimit) +
        `\n\n[Truncated to limit=${queryLimit}. Additional matches exist. Refine query or paginate without query via offset.]`;
    }
    text = cap(text, `Total ${total} chars${pdfPages}; matching paragraphs only.`);
    return { text: wrap(page, text), label: isPdf ? 'Read PDF' : 'Read Page', detail };
  }

  const rawOffset = Number.isFinite(args?.offset) ? Math.max(0, Math.trunc(args.offset)) : 0;
  const rawLimit = Number.isFinite(args?.limit) ? Math.trunc(args.limit) : 4000;
  const limit = Math.min(Math.max(rawLimit, 200), RESULT_CAP);
  const offset = Math.min(rawOffset, total);
  const slice = body.slice(offset, offset + limit);
  const end = offset + slice.length;
  const more = end < total;

  let text = `(Document range: chars ${offset + 1}–${end} of ${total}${pdfPages})\n\n${slice}`;
  if (more) text += `\n\n[${total - end} chars remaining. Continue with offset=${end}]`;

  return {
    text: wrap(page, cap(text, `Total ${total} chars${pdfPages}.`)),
    label: isPdf ? 'Read PDF' : 'Read Page',
    detail: `Chars ${offset + 1}–${end} / ${total}${pdfPages}`,
  };
}

/* ---------------- web_search ---------------- */

async function webSearch(args, { apiKey, baseUrl, signal }) {
  const query = String(args?.query ?? '').trim();
  if (!query) return { text: 'Search query is empty.', label: 'Web Search', detail: 'Empty query' };
  const count = Math.min(Math.max(Number(args?.count) || 5, 1), 10);
  const needContent = args?.need_content === true;

  const res = await fetchJson(`${withV1(baseUrl)}/tools/search`, { query, count, need_content: needContent }, apiKey, signal);
  const results = Array.isArray(res?.results) ? res.results : [];
  if (!results.length) {
    return { text: `No results found for "${query}".`, label: 'Web Search', detail: query };
  }

  const lines = results.map((r, i) => {
    const head = `${i + 1}. ${r.title || '(Untitled)'} — ${r.url}`;
    const meta = [r.site_name, r.date ? String(r.date).slice(0, 10) : '', typeof r.rerank_score === 'number' ? `score ${r.rerank_score}` : '']
      .filter(Boolean)
      .join(' · ');
    const body = needContent && r.content ? r.content : r.summary || r.snippet || '';
    return [head, meta ? `   ${meta}` : '', body ? `   ${body}` : ''].filter(Boolean).join('\n');
  });

  const text = cap(`Search results for "${query}":\n\n${lines.join('\n\n')}`, `Total ${results.length} results.`);
  return {
    text: untrusted(`source="web_search" query="${escapeAttr(query)}"`, text),
    label: 'Web Search',
    detail: query,
  };
}

/* ---------------- fetch_url ---------------- */

async function fetchUrl(args, { apiKey, baseUrl, signal }) {
  const url = String(args?.url ?? '').trim();
  if (!/^https?:\/\//i.test(url)) {
    return { text: `Invalid HTTP/HTTPS URL: ${url}`, label: 'Fetch URL', detail: url };
  }
  try {
    assertPublicHttpUrl(url);
  } catch (err) {
    throw new ToolError(400, `不允许抓取这个地址：${err?.message ?? err}`);
  }

  // Handle PDF documents directly via PDF parsing pipeline
  if (looksLikePdfUrl(url)) {
    const out = await fetchPdf(url, signal);
    const note = out.truncated
      ? `(PDF: ${out.pageCount} pages, truncated to initial segment)`
      : `(PDF: ${out.pageCount} pages)`;
    const text = cap(out.text, note);
    return {
      text: untrusted(`source="fetch_url" url="${escapeAttr(url)}" kind="pdf"`, `${note}\n\n${text}`),
      label: 'Read PDF',
      detail: `${out.pageCount} pages · ${out.chars} chars`,
    };
  }

  const res = await fetchJson(`${withV1(baseUrl)}/tools/fetch`, { url }, apiKey, signal);
  const title = res?.title || '';
  const content = res?.content || '';
  if (!content) return { text: `URL fetched successfully, but no content was extracted: ${url}`, label: 'Fetch URL', detail: url };

  const text = cap(content, `(Original length: ${content.length} chars, truncated)`);
  return {
    text: untrusted(`source="fetch_url" url="${escapeAttr(url)}" title="${escapeAttr(title)}"`, text),
    label: 'Fetch URL',
    detail: title || url,
  };
}

function looksLikePdfUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const path = u.pathname.toLowerCase();
  if (path.endsWith('.pdf')) return true;
  const q = u.search.toLowerCase();
  return /(^|[?&])(format|type|download)=pdf/.test(q);
}

/** In-memory cache for parsed PDF content to avoid redundant round-trips */
const pdfCache = new Map();

async function fetchPdf(url, signal) {
  const hit = pdfCache.get(url);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value;

  assertPublicHttpUrl(url);
  const timeout = AbortSignal.timeout(30_000);
  const stop = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/pdf,*/*' }, signal: stop, redirect: 'follow' });
  } catch (err) {
    if (timeout.aborted) throw new ToolError(504, 'Fetching PDF timed out after 30s');
    throw err;
  }
  if (!res.ok) throw new ToolError(res.status, `Failed to fetch PDF: HTTP ${res.status}`);
  const buf = await readBodyCapped(res, 64 * 1024 * 1024);

  const out = await extractPdfText(buf);
  if (!out.text.trim()) {
    throw new ToolError(404, 'PDF contains no extractable text layer (likely scanned). Use screenshot instead.');
  }
  pdfCache.set(url, { at: Date.now(), value: out });
  if (pdfCache.size > 12) pdfCache.delete(pdfCache.keys().next().value);
  return out;
}

/* ---------------- Helpers ---------------- */

function wrap(page, text) {
  const kind = page?.kind === 'pdf' ? ' kind="pdf"' : '';
  return untrusted(
    `source="page"${kind} url="${escapeAttr(page?.url ?? '')}" title="${escapeAttr(page?.title ?? '')}"`,
    text,
  );
}

/**
 * Wraps external content in one envelope. If the body contains </untrusted_content>, the model thinks the
 * container ended early and treats the rest of the page text as system/user instructions — escape it first.
 */
function untrusted(attrs, text) {
  const body = String(text ?? '').replace(/<(\/?\s*untrusted_content)/gi, '&lt;$1');
  return `<untrusted_content ${attrs}>\n${body}\n</untrusted_content>`;
}

function cap(text, note) {
  if (text.length <= RESULT_CAP) return text;
  const suffix = `\n\n[Truncated: output limited to first ${RESULT_CAP} chars. ${note} Narrow the query or range to retrieve more.]`;
  const room = Math.max(0, RESULT_CAP - suffix.length);
  return `${text.slice(0, room)}${suffix}`;
}

async function fetchJson(url, payload, apiKey, signal) {
  const timeout = AbortSignal.timeout(30_000);
  const stop = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
      signal: stop,
    });
  } catch (err) {
    if (timeout.aborted) throw new ToolError(504, 'Upstream tool request timed out after 30s');
    throw err;
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new ToolError(res.status, `${url} returned HTTP ${res.status}: ${detail.slice(0, 300)}`);
  }
  const buf = await readBodyCapped(res, 4 * 1024 * 1024);
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new ToolError(502, `${url} returned invalid JSON`);
  }
}

export class ToolError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }

  /** Standardized, user-facing error message */
  userMessage() {
    const hints = {
      400: 'Invalid request',
      401: 'Invalid API key',
      402: 'Insufficient account balance',
      403: 'Access denied by target site security policy',
      404: 'Resource unavailable (link broken or blocked)',
      408: 'Request timeout',
      413: 'Payload exceeds allowed size',
      429: 'Rate limit exceeded, retry later',
      500: 'Internal search service error',
      504: 'Upstream gateway timeout',
    };
    return hints[this.status] ?? this.message.slice(0, 200);
  }
}

function escapeAttr(s) {
  return String(s).replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c]);
}