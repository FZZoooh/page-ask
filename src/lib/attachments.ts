// Attachments: upload to the backend (which sniffs, extracts and stores the file), plus image helpers.
// The panel never parses documents itself; it only shrinks images so a phone photo does not cost
// megabytes of base64 on every replayed turn.
import { authHeaders, backendErrorText, endpoint } from './chat';
import { t, type MessageKey } from './i18n';
import { baseUrl, type Settings } from './settings';

export type AttachmentFormat = 'image' | 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'text';

/** Backend attachment metadata (publicAttachment in server/db.mjs) */
export interface Attachment {
  id: string;
  name: string;
  mime: string;
  format: AttachmentFormat;
  kind: 'image' | 'document';
  size: number;
  pages?: number | null;
  chars?: number | null;
  truncated?: boolean;
}

/** A card in the composer or the inline editor, before the message is sent */
export interface DraftAttachment {
  key: string;
  name: string;
  /** Guessed from the file while uploading; replaced by the backend's sniffed format afterwards */
  format: AttachmentFormat | 'file';
  status: 'uploading' | 'ready';
  /** Local object URL for image thumbnails */
  previewUrl?: string;
  attachment?: Attachment;
  /** Uploaded from this draft, so removing the card deletes the pending upload on the backend */
  owned: boolean;
}

export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const IMAGE_MAX_EDGE = 2048;

const TEXT_EXTENSIONS = [
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'xml', 'html', 'htm', 'yaml', 'yml', 'toml', 'ini',
  'log', 'tex', 'rst', 'srt', 'vtt', 'svg', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'java', 'kt', 'c', 'h',
  'cpp', 'hpp', 'cc', 'cs', 'go', 'rs', 'rb', 'php', 'swift', 'lua', 'r', 'sql', 'sh', 'ps1', 'bat', 'css', 'scss',
  'less', 'vue', 'svelte',
];

/** File dialog filter; the backend still decides by content, so this is only a convenience */
export const ATTACHMENT_ACCEPT = [
  'image/*',
  '.pdf',
  '.docx',
  '.xlsx',
  '.pptx',
  'text/*',
  ...TEXT_EXTENSIONS.map((ext) => `.${ext}`),
].join(',');

export function guessFormat(name: string, mime: string): AttachmentFormat | 'file' {
  if (mime.startsWith('image/') && mime !== 'image/svg+xml') return 'image';
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  if (ext === 'pdf' || mime === 'application/pdf') return 'pdf';
  if (ext === 'docx' || ext === 'xlsx' || ext === 'pptx') return ext;
  if (mime.startsWith('text/') || TEXT_EXTENSIONS.includes(ext)) return 'text';
  return 'file';
}

const TYPE_KEYS: Record<AttachmentFormat | 'file', MessageKey> = {
  image: 'attachment.type.image',
  pdf: 'attachment.type.pdf',
  docx: 'attachment.type.docx',
  xlsx: 'attachment.type.xlsx',
  pptx: 'attachment.type.pptx',
  text: 'attachment.type.text',
  file: 'attachment.type.file',
};

export function attachmentTypeLabel(format: AttachmentFormat | 'file'): string {
  return t(TYPE_KEYS[format] ?? 'attachment.type.file');
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Drag/paste payload carries files (Explorer copy, screenshots, images dragged in) */
export function hasTransferFiles(dt: DataTransfer | null): boolean {
  return Boolean(dt && Array.from(dt.types).includes('Files'));
}

export function transferFiles(dt: DataTransfer | null): File[] {
  return dt ? Array.from(dt.files) : [];
}

/** The pasted text as a .txt attachment when the setting is on and it reaches the threshold; else null */
export function pastedTextFile(settings: Settings, text: string): File | null {
  if (!settings.pasteAsFile || !text.trim()) return null;
  // Cheap pre-check: UTF-8 never uses fewer bytes than UTF-16 code units, nor more than three per unit.
  if (text.length * 3 < settings.pasteAsFileBytes) return null;
  const bytes = new TextEncoder().encode(text);
  if (bytes.length < settings.pasteAsFileBytes) return null;
  const now = new Date();
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()].map((n) => String(n).padStart(2, '0')).join('-');
  return new File([bytes], t('attachment.pastedName', { time }), { type: 'text/plain' });
}

const KEEP_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/**
 * Shrink an image to IMAGE_MAX_EDGE on its long side. Formats the backend cannot sniff (BMP, AVIF, …)
 * are re-encoded even when small. A GIF within the limit stays as is, so its animation survives.
 * Anything the browser cannot decode is returned unchanged and left for the backend to judge.
 */
export async function prepareImage(file: File): Promise<Blob> {
  if (!file.type.startsWith('image/') || file.type === 'image/svg+xml') return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }
  try {
    const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && KEEP_IMAGE_TYPES.has(file.type)) return file;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, width, height);
    // JPEG has no alpha channel; everything else may carry transparency, so keep a lossless-alpha format.
    const type = file.type === 'image/jpeg' ? 'image/jpeg' : file.type === 'image/webp' ? 'image/webp' : 'image/png';
    return await canvas.convertToBlob({ type, quality: 0.9 });
  } catch {
    return file;
  } finally {
    bitmap.close();
  }
}

export async function uploadAttachment(
  settings: Settings,
  body: Blob,
  name: string,
  signal?: AbortSignal,
): Promise<Attachment> {
  let res: Response;
  try {
    res = await fetch(endpoint(settings, '/attachments'), {
      method: 'POST',
      headers: {
        ...authHeaders(settings),
        'Content-Type': 'application/octet-stream',
        // Header values are ByteStrings; a CJK file name must be percent-encoded to survive.
        'X-File-Name': encodeURIComponent(name),
      },
      body,
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new Error(t('error.unreachable', { baseUrl: baseUrl(settings) }));
  }
  if (!res.ok) throw new Error(await backendErrorText(res));
  return (await res.json()) as Attachment;
}

/** Drop a pending (never sent) upload. Best effort: the backend sweeps leftovers after 24 h anyway. */
export function discardAttachment(settings: Settings, id: string): void {
  void fetch(endpoint(settings, `/attachments/${encodeURIComponent(id)}`), {
    method: 'DELETE',
    headers: authHeaders(settings),
  }).catch(() => {});
}

/** Object URLs for image attachments, shared by thumbnails and the full-size preview */
const imageUrls = new Map<string, Promise<string>>();

export function rememberImageUrl(id: string, url: string): void {
  imageUrls.set(id, Promise.resolve(url));
}

export function attachmentImageUrl(settings: Settings, id: string): Promise<string> {
  const hit = imageUrls.get(id);
  if (hit) return hit;
  const load = (async () => {
    const res = await fetch(endpoint(settings, `/attachments/${encodeURIComponent(id)}/content`), {
      headers: authHeaders(settings),
    });
    if (!res.ok) throw new Error(await backendErrorText(res));
    return URL.createObjectURL(await res.blob());
  })();
  imageUrls.set(id, load);
  // A failed load must not stick: the backend may simply have been down for a moment.
  load.catch(() => imageUrls.delete(id));
  return load;
}
