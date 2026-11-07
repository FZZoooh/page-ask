import Defuddle from 'defuddle';
import { t } from '@/lib/i18n';
import { looksLikePdfUrl, PdfReadError, readPdfFromTab } from '@/lib/pdf';

/** 从目标标签页原样带回来的东西 */
export interface RawPage {
  url: string;
  title: string;
  html: string;
  selection: string;
  viewport: ViewportSnapshot;
}

/** 当前可见区域（用户此刻屏幕上看到的那一屏） */
export interface ViewportSnapshot {
  scrollY: number;
  height: number;
  scrollHeight: number;
  text: string;
}

/** 解析后的正文 */
export interface ExtractedPage {
  url: string;
  title: string;
  site: string;
  markdown: string;
  chars: number;
  selection: string;
  viewport: ViewportSnapshot;
  tookMs: number;
  /** pdf = 正文来自 PDF 文本层（此时没有 DOM、没有滚动位置） */
  kind?: 'web' | 'pdf';
  /** PDF 的页数 */
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
 * 在目标标签页中执行。
 *
 * ⚠️ 这个函数会被 `scripting.executeScript({ func })` 序列化后注入页面，
 * 因此必须完全自包含：不 import、不引用模块作用域里的任何变量。
 */
export function grabPage() {
  const DROP = 'script,style,noscript,iframe,svg,canvas,video,audio,object,embed';
  const clone = document.documentElement.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(DROP).forEach((el) => el.remove());

  let selection = '';
  try {
    selection = (window.getSelection()?.toString() ?? '').slice(0, 20000);
  } catch {
    /* 某些页面禁用 selection，忽略 */
  }

  // 当前可见区域的文字：只取「直接装有文字」的块，避免父子重复
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
    /* 拿不到就算了，read_page 还能读全文 */
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

/** 纯函数：给定原始 HTML，产出可喂给模型的 Markdown。 */
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
    console.warn('[pageask] Defuddle 解析失败，回退到纯文本', err);
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
  // 内部页面（新建标签页、edge:// 各处、扩展商店）有时拿不到 tab.url，
  // 只能靠浏览器自己的报错文案判断。
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

/** 读取「当前窗口的当前标签页」，提取正文。 */
export async function readActiveTab(opts: { backendUrl?: string } = {}): Promise<ReadResult> {
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

  // PDF 走另一条路：浏览器内嵌查看器读不到 DOM，只能取字节交给后端解析
  if (looksLikePdfUrl(tab.url) && tab.url) {
    return readPdfTab(tab.url, tab.title, opts.backendUrl);
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
 * 「用户此刻选中的文字」+ 它所在的那一段。
 * 面板是在页面加载/切标签时读正文的，用户通常是「先选中、再提问」，
 * 所以发消息前再取一次，比用缓存里的 selection 准。
 *
 * 只发选中几个字时，模型常常判断不了语气/指代（「它」「这种做法」指的是什么），
 * 所以顺带把它所在的块级容器（p/li/td/…）一起带上，并用 start/end 标出选中位置。
 * PDF 页注入不进去，返回 null。
 */
export interface SelectionInfo {
  /** 选中的原文（空白已规范化） */
  text: string;
  /** 选区所在块级容器的文字，过长时截成选中处前后的窗口 */
  context: string;
  /** 选中部分在 context 里的起点 */
  start: number;
  /** 选中部分在 context 里的终点（不含） */
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

        // 最贴近选区的块级容器：没有就直接用所在元素
        const block =
          el.closest('p,li,td,th,dd,dt,blockquote,pre,h1,h2,h3,h4,h5,h6,figcaption') ?? el;
        const full = norm(block.textContent ?? '');

        const at = full.indexOf(text);
        if (at < 0) {
          // 跨块选区，或原文里空白被规范化过，退化成「只有选区」
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

/** PDF 标签页：取字节 → 后端抽文本 → 当成一页 markdown */async function readPdfTab(url: string, title: string | undefined, backendUrl?: string): Promise<ReadResult> {
  const started = performance.now();
  if (!backendUrl) {
    return { ok: false, reason: 'unknown', message: t('page.failure.pdfNeedBackend'), url };
  }

  try {
    const out = await readPdfFromTab(url, backendUrl);
    let site = '';
    try {
      site = new URL(url).hostname;
    } catch {
      site = '';
    }
    // 浏览器给 PDF 标签页的 title 常常是被剥掉扩展名的 URL，这里优先用文件名
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

/** 让用户为当前站点授权（activeTab 失效、或从侧栏菜单直接打开时用） */
export async function grantOrigin(url?: string): Promise<boolean> {
  if (!url) return false;
  if (url.startsWith('file://')) {
    // file:// 无法动态授权，需在扩展详情页手动勾选「允许访问文件 URL」
    return false;
  }
  let origin: string;
  try {
    origin = `${new URL(url).origin}/*`;
  } catch {
    return false;
  }
  try {
    return await browser.permissions.request({ origins: [origin] });
  } catch {
    return false;
  }
}

/** 粗略 token 估算：中文约 1 字 ≈ 1 token，纯英文 ≈ 4 字符 / token，混合取 0.6 */
export function estimateTokens(chars: number): number {
  return Math.round(chars * 0.6);
}

/**
 * 截当前活动标签页的可见区域，缩到 maxWidth 以内并转成 JPEG data URL。
 * 失败（无权限、浏览器内部页面、canvas 不可用）返回 null，不影响主流程。
 */
export async function captureScreenshot(
  maxWidth = 1280,
): Promise<{ dataUrl: string; width: number; height: number } | null> {
  try {
    const raw = await browser.tabs.captureVisibleTab({ format: 'jpeg', quality: 80 });
    if (!raw) return null;

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
    console.warn('[pageask] 截图失败', err);
    return null;
  }
}
