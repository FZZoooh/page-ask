import Defuddle from 'defuddle';
import { t } from '@/lib/i18n';
import { looksLikePdfUrl, PdfReadError, readPdfFromTab } from '@/lib/pdf';

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

  // Text in the visible area: only blocks that directly hold text, so parents do not repeat children
  let visible = '';
  try {
    const vh = window.innerHeight || 0;
    const out: string[] = [];
    let budget = 20000;
    const nodes = document.body ? Array.from(document.body.querySelectorAll<HTMLElement>('*')) : [];
    for (const el of nodes) {
      if (out.length > 600 || budget <= 0) break;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.bottom <= 0 || rect.top >= vh) continue;
      let hasTextChild = false;
      for (const child of Array.from(el.children)) {
        if ((child.textContent ?? '').trim()) {
          hasTextChild = true;
          break;
        }
      }
      if (hasTextChild) continue;
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

/** Pure function: raw HTML in, Markdown the model can be fed out. */
export function extract(raw: RawPage): ExtractedPage {
  const started = performance.now();
  const doc = new DOMParser().parseFromString(raw.html, 'text/html');

  let markdown = '';
  let title = raw.title;
  let site = '';

  try {
    const res = new Defuddle(doc, { url: raw.url, markdown: true }).parse();
    markdown = (res.contentMarkdown ?? '').trim();
    if (!markdown && res.content) markdown = htmlToText(res.content);
    title = res.title?.trim() || title;
    site = res.site || res.domain || '';
  } catch (err) {
    console.warn('[pageask] Defuddle parse failed; falling back to plain text', err);
    markdown = doc.body ? htmlToText(doc.body.innerHTML) : '';
  }

  if (!site) {
    try {
      site = new URL(raw.url).hostname;
    } catch {
      site = '';
    }
  }

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
  // Some sites (e.g. arxiv's /pdf/2401.12345) have no .pdf in the URL, so fall back to the tab title.
  const pdfByTitle = /\.pdf\s*$/i.test((tab.title ?? '').trim());
  if ((looksLikePdfUrl(tab.url) || pdfByTitle) && tab.url) {
    return readPdfTab(tab.url, tab.title, opts.backendUrl, opts.token);
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

export async function readSelection(): Promise<SelectionInfo | null> {
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab?.id || isRestrictedUrl(tab.url)) return null;
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
    let site = '';
    try {
      site = new URL(url).hostname;
    } catch {
      site = '';
    }
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
    return { ok: false, reason: 'unknown', message, url };
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
    const stripHash = (url?: string) => (url ? url.split('#')[0] : '');
    if (expectedUrl && stripHash(tab?.url) !== stripHash(expectedUrl)) return null;

    const raw = await browser.tabs.captureVisibleTab(tab?.windowId, { format: 'jpeg', quality: 80 });
    if (!raw) return null;

    // captureVisibleTab is async: re-check the active tab so page A's shot never goes out with page B's question
    const [after] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id != null && after?.id !== tab.id) return null;
    if (expectedUrl && stripHash(after?.url) !== stripHash(expectedUrl)) return null;

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
