// User attachments: sniff the real format from the bytes, extract text from documents, and store the
// original under data/attachments/. The file name is only a label; it never decides how bytes are parsed.
import { randomBytes } from 'node:crypto';
import { renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { attachmentsDir, createAttachment } from './db.mjs';
import { extractOffice, officeFormat, OfficeError } from './office.mjs';
import { extractPdfText, MAX_CHARS, PdfError } from './pdf.mjs';

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

export class AttachmentError extends Error {
  constructor(code, params = undefined, message = code) {
    super(message);
    this.code = code;
    this.params = params;
  }
}

const OFFICE_MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** Header value (URI-encoded by the client) → a display name without paths or control characters */
export function safeFileName(raw) {
  let name = String(raw ?? '');
  try {
    name = decodeURIComponent(name);
  } catch {
    /* not encoded: keep as is */
  }
  name = name
    .split(/[\\/]/)
    .pop()
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, 200);
  return name || 'file';
}

function imageType(b) {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { mime: 'image/png', ext: 'png' };
  if (b.subarray(0, 6).toString('ascii') === 'GIF87a' || b.subarray(0, 6).toString('ascii') === 'GIF89a') {
    return { mime: 'image/gif', ext: 'gif' };
  }
  if (b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp' };
  }
  return null;
}

/**
 * Plain text in UTF-8 / UTF-16 (BOM) / GB18030. Returns null for binary: NUL bytes outside UTF-16,
 * or a GB18030 decode full of control characters (that decoder accepts almost any byte sequence).
 */
function decodeText(b) {
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  if (b.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    const text = new TextDecoder('gb18030').decode(b);
    // eslint-disable-next-line no-control-regex
    const control = text.match(/[\u0001-\u0008\u000e-\u001f\u007f\ufffd]/g)?.length ?? 0;
    return control > text.length / 100 ? null : text;
  }
}

function textExt(name) {
  const m = /\.([a-z0-9]{1,10})$/i.exec(name);
  return m ? m[1].toLowerCase() : 'txt';
}

/**
 * Parse, store and register one upload as a pending attachment.
 * @param {{ bytes: Buffer, name: string, signal?: AbortSignal }} input
 */
export async function ingestAttachment({ bytes, name, signal }) {
  if (!bytes.length) throw new AttachmentError('attachment.no_text');
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentError('attachment.too_large', { limitMb: MAX_ATTACHMENT_BYTES / 1024 / 1024 });
  }

  let kind = 'document';
  let format;
  let mime;
  let ext;
  let text = null;
  let pages = null;
  let truncated = false;

  const image = imageType(bytes);
  if (image) {
    kind = 'image';
    format = 'image';
    ({ mime, ext } = image);
  } else if (bytes.subarray(0, 5).toString('ascii') === '%PDF-') {
    format = 'pdf';
    mime = 'application/pdf';
    ext = 'pdf';
    try {
      // pdfjs transfers (detaches) the buffer it gets; hand it a copy so `bytes` can still be written.
      const out = await extractPdfText(new Uint8Array(bytes), { signal });
      text = out.text;
      pages = out.pageCount;
      truncated = out.truncated;
    } catch (err) {
      if (err instanceof PdfError && err.code === 'cancelled') throw err;
      throw new AttachmentError('attachment.unreadable', undefined, err?.message ?? String(err));
    }
  } else if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    format = officeFormat(bytes);
    if (!format) throw new AttachmentError('attachment.unsupported');
    mime = OFFICE_MIME[format];
    ext = format;
    try {
      ({ text, pages } = extractOffice(bytes, format));
    } catch (err) {
      if (!(err instanceof OfficeError)) throw err;
      throw new AttachmentError('attachment.unreadable', undefined, err.message);
    }
  } else {
    // Legacy binary Office (.doc/.xls/.ppt) starts with the OLE signature D0 CF 11 E0 and lands here
    // too: it contains NUL bytes, so decodeText rejects it as unsupported.
    text = decodeText(bytes);
    if (text === null) throw new AttachmentError('attachment.unsupported');
    format = 'text';
    mime = 'text/plain';
    ext = textExt(name);
  }

  if (kind === 'document') {
    text = text.replace(/\r\n?/g, '\n');
    if (!text.trim()) throw new AttachmentError('attachment.no_text');
    if (text.length > MAX_CHARS) {
      text = text.slice(0, MAX_CHARS);
      truncated = true;
    }
  }

  const id = `f_${randomBytes(6).toString('hex')}`;
  const file = `${id}.${ext}`;
  const full = join(attachmentsDir, file);
  const tmp = join(attachmentsDir, `.tmp-${id}`);
  writeFileSync(tmp, bytes, { mode: 0o600 });
  renameSync(tmp, full);
  try {
    return createAttachment({
      id,
      name,
      mime,
      format,
      kind,
      size: bytes.length,
      file,
      text,
      pages,
      chars: text?.length ?? null,
      truncated,
    });
  } catch (err) {
    try {
      unlinkSync(full);
    } catch {
      /* best effort */
    }
    throw err;
  }
}
