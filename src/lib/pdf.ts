/**
 * PDF support.
 *
 * The browser renders PDFs in its own embedded viewer (pdf.js in a chrome-extension),
 * so the page exposes no readable DOM and `scripting.executeScript` cannot get in.
 * Reading one therefore means: extension fetches bytes with the user's cookies → local backend parses.
 *
 * Split: this file only downloads and encodes (the browser has the cookies); all parsing is backend.
 */
import { t, tError } from '@/lib/i18n';

/** What the backend's /pdf returns */
export interface PdfExtract {
  pageCount: number;
  chars: number;
  truncated: boolean;
  text: string;
}

export class PdfReadError extends Error {
  /** Stable code lets the caller distinguish "not actually a PDF" from a transient read failure */
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

const MAX_BYTES = 45 * 1024 * 1024;
/** The backend caps the JSON body at 64 MB; base64 expands by 4/3, so keep raw PDF bytes below that. */
const MAX_RAW_LABEL = '45 MB';

const PDF_FETCH_TIMEOUT_MS = 30_000;
const PDF_BACKEND_TIMEOUT_MS = 120_000;

/** AbortSignal.timeout() rejects with a DOMException named TimeoutError */
function isTimeout(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: string }).name === 'TimeoutError';
}

function tooBig(size: string): PdfReadError {
  return new PdfReadError(t('page.failure.pdfTooBig', { size, limit: MAX_RAW_LABEL }));
}

/** Read a response body without ever buffering more than MAX_BYTES; content-length only shortcuts the common case. */
async function readCappedBody(res: Response): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    await res.body?.cancel().catch(() => {});
    throw tooBig(`${Math.round(declared / 1024 / 1024)} MB`);
  }

  if (!res.body) {
    throw new PdfReadError(t('page.failure.pdfFetch', { message: 'empty response' }), 'pdf.fetch');
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel().catch(() => {});
        throw tooBig(`${Math.round(total / 1024 / 1024)} MB`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** The backend token is optional, but when configured every endpoint (including /pdf) requires it */
function tokenHeader(token?: string): Record<string, string> {
  const value = token?.trim();
  return value ? { Authorization: `Bearer ${value}` } : {};
}

/** Does the link look like a PDF? */
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

/** Uint8Array → base64; chunked so a big file does not blow the argument stack */
function toBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Derive /pdf from the configured base, dropping any query/hash the settings page should have rejected */
function pdfEndpoint(backendUrl: string): string {
  try {
    const u = new URL(backendUrl);
    u.search = '';
    u.hash = '';
    u.pathname = `${u.pathname.replace(/\/+$/, '')}/pdf`;
    return u.toString();
  } catch {
    return `${backendUrl.replace(/\/+$/, '')}/pdf`;
  }
}

/**
 * Local file:// PDF: extension fetch does not support file:// (even with "Allow access to file URLs" on),
 * so pass the path to the backend and let it read the disk.
 */
async function readLocalPdf(fileUrl: string, backendUrl: string, token?: string): Promise<PdfExtract> {
  const endpoint = pdfEndpoint(backendUrl);
  let parsed: Response;
  try {
    parsed = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...tokenHeader(token) },
      body: JSON.stringify({ fileUrl }),
      signal: AbortSignal.timeout(PDF_BACKEND_TIMEOUT_MS),
    });
  } catch (err) {
    if (isTimeout(err)) throw new PdfReadError(t('page.failure.pdfTimeout'), 'pdf.timeout');
    throw new PdfReadError(
      t('error.unreachable', { baseUrl: backendUrl }) + ` (${err instanceof Error ? err.message : String(err)})`,
      'pdf.unreachable',
    );
  }
  if (!parsed.ok) throw await pdfHttpError(parsed);
  return finishPdf(parsed);
}

/** Fetch the current tab's PDF bytes and have the backend extract the text */
export async function readPdfFromTab(url: string, backendUrl: string, token?: string): Promise<PdfExtract> {
  if (url.startsWith('file://')) return readLocalPdf(url, backendUrl, token);

  let res: Response;
  try {
    res = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(PDF_FETCH_TIMEOUT_MS) });
  } catch (err) {
    if (isTimeout(err)) throw new PdfReadError(t('page.failure.pdfTimeout'), 'pdf.timeout');
    throw new PdfReadError(
      t('page.failure.pdfFetch', { message: err instanceof Error ? err.message : String(err) }),
      'pdf.fetch',
    );
  }
  if (!res.ok) {
    throw new PdfReadError(t('page.failure.pdfFetch', { message: `HTTP ${res.status}` }), 'pdf.fetch');
  }

  const buf = await readCappedBody(res);
  // Some sites wrap the PDF behind a login page, so what comes back is actually HTML
  const head = String.fromCharCode(...buf.subarray(0, 5));
  if (head !== '%PDF-') {
    throw new PdfReadError(t('page.failure.pdfNotPdf'), 'pdf.not_pdf');
  }

  const endpoint = pdfEndpoint(backendUrl);
  let parsed: Response;
  try {
    parsed = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...tokenHeader(token) },
      body: JSON.stringify({ base64: toBase64(buf) }),
      signal: AbortSignal.timeout(PDF_BACKEND_TIMEOUT_MS),
    });
  } catch (err) {
    if (isTimeout(err)) throw new PdfReadError(t('page.failure.pdfTimeout'), 'pdf.timeout');
    throw new PdfReadError(
      t('error.unreachable', { baseUrl: backendUrl }) + ` (${err instanceof Error ? err.message : String(err)})`,
      'pdf.unreachable',
    );
  }

  if (!parsed.ok) throw await pdfHttpError(parsed);

  return finishPdf(parsed);
}

/** Turn the backend's /pdf 4xx/5xx into readable text (a 500 must not read as "no text layer") */
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
    /* backend sent no JSON: keep the status code */
  }
  return new PdfReadError(t('page.failure.pdfParse', { message: tError(code, params, detail) }));
}

/** Validate the /pdf response and hand the text back to the caller */
async function finishPdf(parsed: Response): Promise<PdfExtract> {
  const out = (await parsed.json()) as PdfExtract;
  if (!out.text?.trim()) {
    throw new PdfReadError(t('page.failure.pdfNoText'));
  }
  return out;
}
