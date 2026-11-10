import Defuddle from 'defuddle/full';
import { normalizeTableSpans } from '@/lib/table-markdown.mjs';
import { t } from '@/lib/i18n';
import { looksLikePdfUrl, PdfReadError, readPdfFromTab } from '@/lib/pdf';
import { sameDocumentUrl } from '@/lib/settings';

/** Whatever comes back from the target tab, untouched */
export interface RawPage {
  url: string;
  title: string;
  html: string;
  selection: string;
  viewport: ViewportSnapshot;
}

/** What is on screen right now (the screenful the user is looking at) */
export interface ViewportSnapshot {
  scrollY: number;
  height: number;
  scrollHeight: number;
  text: string;
}

/** Parsed page text */
export interface ExtractedPage {
  url: string;
  title: string;
  site: string;
  markdown: string;
  chars: number;
  selection: string;
  viewport: ViewportSnapshot;
  tookMs: number;
  /** pdf = text came from the PDF text layer (no DOM, no scroll position then) */
  kind?: 'web' | 'pdf';
  /** PDF page count */
  pages?: number;
}

export type ReadFailureReason = 'restricted' | 'permission' | 'empty' | 'unknown';

export interface ReadFailure {
  reason: ReadFailureReason;
  message: string;
  url?: string;
  /** Optional stable code (PDF path uses pdf.not_pdf to fall back to DOM extraction) */
  code?: string;
}

export type ReadResult = { ok: true; page: ExtractedPage } | ({ ok: false } & ReadFailure);

/**
 * Runs inside the target tab.
 *
 * ⚠️ `scripting.executeScript({ func })` serializes this function and injects it into the page,
 * so it must be fully self-contained: no imports, no references to anything in module scope.
 */
export function grabPage() {
  const DROP = 'script,style,noscript,iframe,svg,canvas,video,audio,object,embed';
  const clone = document.documentElement.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(DROP).forEach((el) => el.remove());

  let selection = '';
  try {
    selection = (window.getSelection()?.toString() ?? '').slice(0, 20000);
  } catch {
    /* some pages block selection; ignore */
  }

  // Text in the visible area: semantic text blocks only, so one large DOM doesn't force thousands
  // of getBoundingClientRect() calls. This is a viewport hint; read_page still has the full body.
  let visible = '';
  try {
    const vh = window.innerHeight || 0;
    const out: string[] = [];
    let budget = 20000;
    const TEXT_BLOCKS =
      'p,li,pre,blockquote,h1,h2,h3,h4,h5,h6,td,th,dd,dt,figcaption,summary,caption';
    const all = document.body ? Array.from(document.body.querySelectorAll<HTMLElement>(TEXT_BLOCKS)) : [];
    const nodes = all.slice(0, 2000);
    for (const el of nodes) {
      if (out.length > 600 || budget <= 0) break;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.bottom <= 0 || rect.top >= vh) continue;
      // A block that already contains another text block is represented by that child; inline
      // children (<span>, <strong>) must not hide the parent's text.
      let hasBlockTextChild = false;
      for (const child of Array.from(el.children)) {
        if (child.matches(TEXT_BLOCKS) && (child.textContent ?? '').trim()) {
          hasBlockTextChild = true;
          break;
        }
      }
      if (hasBlockTextChild) continue;
      const line = (el.innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (!line) continue;
      out.push(line);
      budget -= line.length + 1;
    }
    visible = out.join('\n').slice(0, 20000);
  } catch {
    /* if that fails, never mind: read_page can still read the full text */
  }

  return {
    url: location.href,
    title: document.title,
    html: clone.outerHTML,
    selection,
    viewport: {
      scrollY: Math.round(window.scrollY || 0),
      height: Math.round(window.innerHeight || 0),
      scrollHeight: Math.round(document.documentElement?.scrollHeight || 0),
      text: visible,
    },
  };
}

function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return (doc.body?.textContent ?? '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function plainHeading(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/^#{1,6}\s*/, '')
    .replace(/\s*#+$/, '')
    .trim()
    .toLowerCase();
}

/**
 * Defuddle's standardizeHeadings() turns every h1 into h2 and then deletes the first h2 when its
 * text equals the page title, so contentMarkdown never starts with the title. Put it back: the
 * page title is usually the one line that tells the model what the document is about, and
 * read_page only returns slices of this Markdown (the title metadata is easy to overlook).
 */
export function withTitleHeading(markdown: string, title: string): string {
  const clean = title.replace(/\s+/g, ' ').replace(/^#{1,6}\s*/, '').trim();
  if (!clean || !markdown.trim()) return markdown;

  // A page can keep its own title heading when it differs slightly from metadata.title; only
  // compare the top of the document so a later section with the same name does not suppress it.
  const head = markdown.slice(0, 1000);
  const headingRe = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm;
  for (const match of head.matchAll(headingRe)) {
    if (plainHeading(match[1] ?? '') === plainHeading(clean)) return markdown;
  }
  return `# ${clean}\n\n${markdown}`;
}

/** Rough text mass of the page, used only to tell whether the extraction lost most of it. */
function bodyTextChars(doc: Document): number {
  return (doc.body?.textContent ?? '').replace(/\s+/g, ' ').trim().length;
}

function looksLowYield(markdown: string, bodyChars: number): boolean {
  if (bodyChars < 800) return false;
  if (markdown.length < 500) return true;
  return bodyChars > 4000 && markdown.length < bodyChars * 0.1;
}

/**
 * Site label for the page card. Defuddle names a page without a real site name after its bare
 * domain (`hostname`, `www.` stripped), and `hostname` carries no port - so `127.0.0.1:8811` and
 * `127.0.0.1:9000` (two dev servers, two staging stacks on one host) would show the same label and
 * become indistinguishable in the history records. Use `host` for that fallback: it keeps the
 * explicit non-default port and still hides 80/443 (the URL parser drops default ports itself).
 */
function siteLabel(rawUrl: string, site: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return site;
  }
  const label = site.trim();
  if (!label) return url.host;
  // A real site name ("Example Docs") already identifies the site, and its port is noise.
  if (!url.port) return label;
  const bare = new Set([url.hostname.toLowerCase(), url.hostname.replace(/^www\./, '').toLowerCase()]);
  return bare.has(label.toLowerCase()) ? url.host : label;
}

/** Pure function: raw HTML in, Markdown the model can be fed out. */
export function extract(raw: RawPage): ExtractedPage {
  const started = performance.now();
  const doc = new DOMParser().parseFromString(raw.html, 'text/html');
  normalizeTableSpans(doc);

  let markdown = '';
  let title = raw.title;
  let site = '';
  // Defuddle may hit third-party APIs when useAsync is left on (YouTube transcripts, Reddit, …).
  // In a side panel that would mean hidden requests and unpredictable latency; keep it local.
  // `separateMarkdown` is required: the core `defuddle` entry never converts HTML to Markdown
  // (`contentMarkdown` only exists in the full build), and `markdown: true` would overwrite the
  // HTML that the fallback below needs.
  const options = { url: raw.url, separateMarkdown: true, useAsync: false };

  try {
    const res = new Defuddle(doc, options).parse();
    markdown = (res.contentMarkdown ?? '').trim();
    if (!markdown && res.content) markdown = htmlToText(res.content);
    title = res.title?.trim() || title;
    site = res.site || res.domain || '';

    // Scoring and content-pattern removal are tuned for news articles. On documentation, forums
    // and Q&A pages they can delete code blocks, short sections or whole answers, leaving a few
    // hundred characters. Retry once with the aggressive filters off and keep the longer body.
    if (looksLowYield(markdown, bodyTextChars(doc))) {
      try {
        const relaxed = new Defuddle(doc, {
          ...options,
          removeLowScoring: false,
          removeHiddenElements: false,
          removeContentPatterns: false,
        }).parse();
        let relaxedMarkdown = (relaxed.contentMarkdown ?? '').trim();
        if (!relaxedMarkdown && relaxed.content) relaxedMarkdown = htmlToText(relaxed.content);
        if (relaxedMarkdown.length > markdown.length) markdown = relaxedMarkdown;
        title = relaxed.title?.trim() || title;
        site = site || relaxed.site || relaxed.domain || '';
      } catch (err) {
        console.warn('[pageask] relaxed Defuddle parse failed; keeping first result', err);
      }
    }
  } catch (err) {
    console.warn('[pageask] Defuddle parse failed; falling back to plain text', err);
    markdown = doc.body ? htmlToText(doc.body.innerHTML) : '';
  }

  markdown = withTitleHeading(markdown, title);

  site = siteLabel(raw.url, site);

  return {
    url: raw.url,
    title,
    site,
    markdown,
    chars: markdown.length,
    selection: raw.selection,
    viewport: raw.viewport,
    tookMs: Math.round(performance.now() - started),
  };
}

const RESTRICTED_PREFIXES = [
  'edge://',
  'chrome://',
  'about:',
  'devtools://',
  'view-source:',
  'chrome-extension://',
  'extension://',
  'https://microsoftedge.microsoft.com/addons',
  'https://chrome.google.com/webstore',
  'https://chromewebstore.google.com',
];

function isRestrictedUrl(url?: string): boolean {
  if (!url) return false;
  const u = url.toLowerCase();
  return RESTRICTED_PREFIXES.some((p) => u.startsWith(p));
}

function classify(message: string, url?: string): ReadFailureReason {
  if (isRestrictedUrl(url)) return 'restricted';
  // Internal pages (new tab, edge:// pages, extension stores) sometimes have no tab.url,
  // so the browser's own error wording is the only signal.
  if (/extensions gallery|cannot be scripted|cannot access (a )?(chrome|edge):|cannot access a chrome/i.test(message)) {
    return 'restricted';
  }
  if (/cannot access|extension manifest must request permission|missing host permission/i.test(message)) {
    return 'permission';
  }
  return 'unknown';
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Read the current tab of the current window and extract its text. */
export async function readActiveTab(opts: { backendUrl?: string; token?: string } = {}): Promise<ReadResult> {
  let tabs: Array<{ id?: number; url?: string; title?: string }>;
  try {
    tabs = await browser.tabs.query({ active: true, currentWindow: true });
  } catch (err) {
    return { ok: false, reason: 'unknown', message: t('page.failure.queryTabs', { message: errMsg(err) }) };
  }

  const tab = tabs[0];
  if (!tab?.id) {
    return { ok: false, reason: 'unknown', message: t('page.failure.noTab') };
  }

  if (isRestrictedUrl(tab.url)) {
    return {
      ok: false,
      reason: 'restricted',
      message: t('page.failure.blockedRaw'),
      url: tab.url,
    };
  }

  // PDFs take another path: the built-in viewer exposes no DOM, so the bytes go to the backend.
  // arxiv's /pdf/2401.12345 has no .pdf suffix, so a title ending in .pdf is a hint, not proof:
  // if the bytes turn out to be HTML, fall through to normal DOM extraction instead of failing.
  if (looksLikePdfUrl(tab.url) && tab.url) {
    return readPdfTab(tab.url, tab.title, opts.backendUrl, opts.token);
  }
  const pdfByTitle = /\.pdf\s*$/i.test((tab.title ?? '').trim());
  if (pdfByTitle && tab.url) {
    const attempt = await readPdfTab(tab.url, tab.title, opts.backendUrl, opts.token);
    if (attempt.ok || attempt.code !== 'pdf.not_pdf') return attempt;
  }

  try {
    const results = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      func: grabPage,
    });

    const raw = results[0]?.result as RawPage | undefined;
    if (!raw || !raw.html) {
      return {
        ok: false,
        reason: 'empty',
        message: t('page.failure.noContent'),
        url: tab.url,
      };
    }

    return { ok: true, page: extract(raw) };
  } catch (err) {
    const message = errMsg(err);
    return { ok: false, reason: classify(message, tab.url), message, url: tab.url };
  }
}

/**
 * "The text the user has selected right now" + the paragraph it sits in.
 * The panel reads page text on load and on tab switch, but users usually select first and
 * then ask, so re-reading just before send beats the cached selection.
 *
 * Given only a few selected characters the model often cannot tell tone or what a pronoun means
 * ("it", "this approach"), so we also send the block container (p/li/td/…) it sits in and mark
 * the selection with start/end. PDF tabs cannot be injected into; returns null.
 */
export interface SelectionInfo {
  /** The selected text as-is (whitespace normalized) */
  text: string;
  /** Text of the block container around the selection; long blocks are cut to a window around it */
  context: string;
  /** Where the selection starts inside context */
  start: number;
  /** Where the selection ends inside context (exclusive) */
  end: number;
}

export async function readSelection(expectedUrl?: string): Promise<SelectionInfo | null> {
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab?.id || isRestrictedUrl(tab.url)) return null;
    if (expectedUrl && !sameDocumentUrl(tab.url, expectedUrl)) return null;
    const results = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return null;
        const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
        const text = norm(sel.toString()).slice(0, 20000);
        if (!text) return null;

        const range = sel.getRangeAt(0);
        const node = range.commonAncestorContainer;
        const el =
          node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
        if (!el) return { text, context: text, start: 0, end: text.length };

        // Closest block container to the selection; fall back to the element itself
        const block =
          el.closest('p,li,td,th,dd,dt,blockquote,pre,h1,h2,h3,h4,h5,h6,figcaption') ?? el;
        const full = norm(block.textContent ?? '');

        const at = full.indexOf(text);
        if (at < 0) {
          // Selection spans several blocks, or whitespace was normalized: degrade to "selection only"
          return { text, context: text, start: 0, end: text.length };
        }

        const MAX = 1600;
        const PAD = 600;
        if (full.length <= MAX) {
          return { text, context: full, start: at, end: at + text.length };
        }
        const from = Math.max(0, at - PAD);
        const to = Math.min(full.length, at + text.length + PAD);
        const head = from > 0 ? '…' : '';
        return {
          text,
          context: head + full.slice(from, to) + (to < full.length ? '…' : ''),
          start: at - from + head.length,
          end: at - from + head.length + text.length,
        };
      },
    });
    const info = results[0]?.result as SelectionInfo | null | undefined;
    return info && info.text ? info : null;
  } catch {
    return null;
  }
}

/**
 * Read the currently visible area again at send time.
 *
 * The viewport captured with the page load goes stale as soon as the user scrolls, and
 * read_page(scope="viewport") is exactly the tool meant to answer "what is on screen now".
 * Kept separate from grabPage(): no DOM clone, no Defuddle, just the visible blocks.
 */
export async function readViewport(expectedUrl?: string): Promise<ViewportSnapshot | null> {
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab?.id || isRestrictedUrl(tab.url)) return null;
    if (expectedUrl && !sameDocumentUrl(tab.url, expectedUrl)) return null;

    const results = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const vh = window.innerHeight || 0;
        const out: string[] = [];
        let budget = 20000;
        const TEXT_BLOCKS =
          'p,li,pre,blockquote,h1,h2,h3,h4,h5,h6,td,th,dd,dt,figcaption,summary,caption';
        const all = document.body
          ? Array.from(document.body.querySelectorAll<HTMLElement>(TEXT_BLOCKS))
          : [];
        for (const el of all.slice(0, 2000)) {
          if (out.length > 600 || budget <= 0) break;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          if (rect.bottom <= 0 || rect.top >= vh) continue;
          let hasBlockTextChild = false;
          for (const child of Array.from(el.children)) {
            if (child.matches(TEXT_BLOCKS) && (child.textContent ?? '').trim()) {
              hasBlockTextChild = true;
              break;
            }
          }
          if (hasBlockTextChild) continue;
          const line = (el.innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
          if (!line) continue;
          out.push(line);
          budget -= line.length + 1;
        }
        return {
          scrollY: Math.round(window.scrollY || 0),
          height: Math.round(window.innerHeight || 0),
          scrollHeight: Math.round(document.documentElement?.scrollHeight || 0),
          text: out.join('\n').slice(0, 20000),
        };
      },
    });
    const viewport = results[0]?.result as ViewportSnapshot | null | undefined;
    return viewport ?? null;
  } catch {
    return null;
  }
}

/**
 * Read only the selected text, for the selection hint on the composer's first line.
 *
 * Separate from readSelection(): that one also reads the whole container's textContent so the model
 * can resolve references; this one is polled once a second and must not serialize a screenful too.
 */
export async function readSelectionText(): Promise<string> {
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab?.id || isRestrictedUrl(tab.url)) return '';
    const results = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return '';
        return sel.toString().replace(/\s+/g, ' ').trim().slice(0, 4000);
      },
    });
    return (results[0]?.result as string | undefined) ?? '';
  } catch {
    return '';
  }
}

/** PDF tab: fetch bytes → backend extracts text → one page of markdown */
async function readPdfTab(
  url: string,
  title: string | undefined,
  backendUrl?: string,
  token?: string,
): Promise<ReadResult> {
  const started = performance.now();
  if (!backendUrl) {
    return { ok: false, reason: 'unknown', message: t('page.failure.pdfNeedBackend'), url };
  }

  try {
    const out = await readPdfFromTab(url, backendUrl, token);
    const site = siteLabel(url, '');
    // The browser titles a PDF tab with the URL minus its extension, so prefer the file name
    let fileName = '';
    try {
      const last = new URL(url).pathname.split('/').filter(Boolean).pop();
      if (last) fileName = decodeURIComponent(last);
    } catch {
      fileName = '';
    }
    return {
      ok: true,
      page: {
        url,
        title: fileName || (title ?? '').replace(/\.pdf$/i, '') || site || 'PDF',
        site,
        markdown: out.text,
        chars: out.text.length,
        selection: '',
        viewport: { scrollY: 0, height: 0, scrollHeight: 0, text: '' },
        tookMs: Math.round(performance.now() - started),
        kind: 'pdf',
        pages: out.pageCount,
      },
    };
  } catch (err) {
    const message = err instanceof PdfReadError ? err.message : errMsg(err);
    const code = err instanceof PdfReadError ? err.code : undefined;
    return { ok: false, reason: 'unknown', message, url, code };
  }
}

/** Rough token estimate: Chinese ≈ 1 token/char, plain English ≈ 4 chars/token, mixed ≈ 0.6 */
export function estimateTokens(chars: number): number {
  return Math.round(chars * 0.6);
}

/**
 * Grab the visible area of the active tab, scale it under maxWidth and turn it into a JPEG data URL.
 * Failures (no permission, browser-internal page, canvas unavailable) return null; the flow goes on.
 *
 * expectedUrl: the URL of the page the question came from. captureVisibleTab only captures the
 * active tab of the focused window, so switching tab/window at send time grabs a different page.
 */
export async function captureScreenshot(
  expectedUrl?: string,
  maxWidth = 1280,
): Promise<{ dataUrl: string; width: number; height: number } | null> {
  try {
    const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    if (expectedUrl && !sameDocumentUrl(tab?.url, expectedUrl)) return null;

    const raw = await browser.tabs.captureVisibleTab(tab?.windowId, { format: 'jpeg', quality: 80 });
    if (!raw) return null;

    // captureVisibleTab is async: re-check the active tab so page A's shot never goes out with page B's question
    const [after] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id != null && after?.id !== tab.id) return null;
    if (expectedUrl && !sameDocumentUrl(after?.url, expectedUrl)) return null;

    const blob = await (await fetch(raw)).blob();
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, maxWidth / bmp.width);
    const width = Math.max(1, Math.round(bmp.width * scale));
    const height = Math.max(1, Math.round(bmp.height * scale));

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0, width, height);
    bmp.close?.();

    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.72 });
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(out);
    });
    return { dataUrl, width, height };
  } catch (err) {
    console.warn('[pageask] screenshot failed', err);
    return null;
  }
}
