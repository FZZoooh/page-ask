/**
 * PDF 支持。
 *
 * 浏览器把 PDF 渲染在自己的内嵌查看器里（pdf.js 的 chrome-extension），
 * 页面里既没有可读的 DOM，`scripting.executeScript` 也进不去，
 * 所以「读 PDF」只能：扩展带着登录态把字节取回来 → 交给本地后端解析。
 *
 * 分工：这里只负责下载与编码（浏览器有 cookie），解析全在后端。
 */
import { t, tError } from '@/lib/i18n';

/** 后端 /pdf 返回的东西 */
export interface PdfExtract {
  pageCount: number;
  chars: number;
  truncated: boolean;
  text: string;
}

export class PdfReadError extends Error {
  constructor(message: string) {
    super(message);
  }
}

const MAX_BYTES = 64 * 1024 * 1024;

/** 链接看起来是不是 PDF */
export function looksLikePdfUrl(url?: string): boolean {
  if (!url) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const path = u.pathname.toLowerCase();
  if (path.endsWith('.pdf')) return true;
  return /(^|[?&])(format|type|download)=pdf/.test(u.search.toLowerCase());
}

/** Uint8Array → base64，分块避免大文件把参数栈打爆 */
function toBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * 本地 file:// PDF：扩展的 fetch 不支持 file 协议（即使勾了「允许访问文件 URL」），
 * 所以直接把路径交给后端，让它读盘。
 */
async function readLocalPdf(fileUrl: string, backendUrl: string): Promise<PdfExtract> {
  const endpoint = `${backendUrl.replace(/\/+$/, '')}/pdf`;
  let parsed: Response;
  try {
    parsed = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileUrl }),
    });
  } catch (err) {
    throw new PdfReadError(
      t('error.unreachable', { baseUrl: backendUrl }) + `（${err instanceof Error ? err.message : String(err)}）`,
    );
  }
  if (!parsed.ok) throw await pdfHttpError(parsed);
  return finishPdf(parsed);
}

/** 取当前标签页的 PDF 字节并让后端抽文本 */
export async function readPdfFromTab(url: string, backendUrl: string): Promise<PdfExtract> {
  if (url.startsWith('file://')) return readLocalPdf(url, backendUrl);

  let res: Response;
  try {
    res = await fetch(url, { credentials: 'include' });
  } catch (err) {
    throw new PdfReadError(t('page.failure.pdfFetch', { message: err instanceof Error ? err.message : String(err) }));
  }
  if (!res.ok) {
    throw new PdfReadError(t('page.failure.pdfFetch', { message: `HTTP ${res.status}` }));
  }

  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_BYTES) {
    throw new PdfReadError(t('page.failure.pdfTooBig', { size: `${Math.round(buf.byteLength / 1024 / 1024)} MB` }));
  }
  // 有些站点把 PDF 包在登录页后面，取回来其实是 HTML
  const head = String.fromCharCode(...buf.subarray(0, 5));
  if (head !== '%PDF-') {
    throw new PdfReadError(t('page.failure.pdfNotPdf'));
  }

  const endpoint = `${backendUrl.replace(/\/+$/, '')}/pdf`;
  let parsed: Response;
  try {
    parsed = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base64: toBase64(buf) }),
    });
  } catch (err) {
    throw new PdfReadError(
      t('error.unreachable', { baseUrl: backendUrl }) + `（${err instanceof Error ? err.message : String(err)}）`,
    );
  }

  if (!parsed.ok) throw await pdfHttpError(parsed);

  return finishPdf(parsed);
}

/** 后端 /pdf 的 4xx/5xx 统一翻成可读文案（别再把 500 说成“没有文字层”） */
async function pdfHttpError(parsed: Response): Promise<PdfReadError> {
  let detail = `HTTP ${parsed.status}`;
  let code: string | undefined;
  let params: Record<string, string | number> | undefined;
  try {
    const body = (await parsed.json()) as {
      message?: string;
      error?: string;
      code?: string;
      params?: Record<string, string | number>;
    };
    code = body.code;
    params = body.params;
    detail = body.message ?? body.error ?? detail;
  } catch {
    /* 后端没给 JSON 就用状态码 */
  }
  return new PdfReadError(t('page.failure.pdfParse', { message: tError(code, params, detail) }));
}

/** 校验 /pdf 的响应并把正文返给上层 */
async function finishPdf(parsed: Response): Promise<PdfExtract> {
  const out = (await parsed.json()) as PdfExtract;
  if (!out.text?.trim()) {
    throw new PdfReadError(t('page.failure.pdfNoText'));
  }
  return out;
}
