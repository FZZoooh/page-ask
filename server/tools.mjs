import { assertPublicHttpUrl, fetchPublic, readBodyCapped } from './net.mjs';
import { extractPdfText } from './pdf.mjs';
import { decodeText, findParagraphs } from './text.mjs';
import { withV1 } from './upstream.mjs';
import { suggestName, WorkspaceError } from './workspace.mjs';
import { logError } from './log.mjs';
import { t } from './i18n/index.mjs';

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
      name: 'read_file',
      description:
        'Reads the extracted text of a document the user attached to this conversation (PDF, Word, Excel, ' +
        'PowerPoint or plain text). Identify it by the file_id from its <attachment> tag. ' +
        'Supports offset/limit pagination and keyword search via query. Images are already in the user message.',
      parameters: {
        type: 'object',
        properties: {
          file_id: { type: 'string', description: 'The file_id attribute of the <attachment> tag.' },
          query: {
            type: 'string',
            description: 'Optional. Keyword filter; returns only matching paragraphs.',
          },
          offset: { type: 'integer', description: 'Optional. Zero-based character offset (default: 0).' },
          limit: { type: 'integer', description: 'Optional. Maximum characters to read (default: 4000, max: 8000).' },
        },
        required: ['file_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'copy_attachment',
      description:
        'Copies a plain-text file the user attached (txt, md, code, CSV, JSON etc.) into this conversation ' +
        'workspace, converted to UTF-8, so it can be edited with edit_file and delivered as a downloadable ' +
        'artifact. Identify it by the file_id from its <attachment> tag. Binary attachments (PDF, Word, ' +
        'Excel, PowerPoint, images) cannot be copied — read those with read_file instead. Same limits as write_file.',
      parameters: {
        type: 'object',
        properties: {
          file_id: { type: 'string', description: 'The file_id attribute of the <attachment> tag.' },
          name: {
            type: 'string',
            description: 'Optional flat filename with a text extension; defaults to the attachment name (adapted if needed).',
          },
          overwrite: { type: 'boolean', description: 'Optional; default false. Explicitly allow replacing an existing workspace file.' },
        },
        required: ['file_id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'Lists names, UTF-8 byte sizes and modification times of the text files in this conversation ' +
        'workspace. No paths or folders.',
      parameters: {
        type: 'object',
        properties: {
          offset: { type: 'integer', description: 'Optional zero-based file offset (default: 0).' },
          limit: { type: 'integer', description: 'Optional number of files (default: 20, max: 20).' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_workspace_file',
      description: 'Reads a generated text file in this conversation workspace by filename, not a path. Supports query and offset/limit pagination. Use read_file for user attachments instead.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Flat filename including a text extension, e.g. report.md.' },
          query: { type: 'string', description: 'Optional keyword search.' },
          offset: { type: 'integer', description: 'Optional zero-based character offset (default: 0).' },
          limit: { type: 'integer', description: 'Optional character limit (default: 4000, max: 8000).' },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Creates a UTF-8 text file in this conversation workspace. Set overwrite=true to replace an existing file. Only flat filenames and text formats (txt, md, html, code, JSON, CSV etc.) are allowed; no paths, folders, binaries or Office files. Max 1 MiB/file, 100 files and 10 MiB/workspace. Never executes code.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Flat filename including a supported text extension.' },
          content: { type: 'string', description: 'Complete UTF-8 text content; may be empty.' },
          overwrite: { type: 'boolean', description: 'Optional; default false. Explicitly allow replacing an existing file.' },
        },
        required: ['name', 'content'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Edits a workspace text file by exact literal replacement. old_text must be nonempty and match exactly once unless replace_all=true. No shell, paths, directories or execution.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Flat filename of an existing workspace text file.' },
          old_text: { type: 'string', description: 'Exact nonempty text to replace.' },
          new_text: { type: 'string', description: 'Replacement text; may be empty to remove the match.' },
          replace_all: { type: 'boolean', description: 'Optional; default false. Replace all occurrences.' },
        },
        required: ['name', 'old_text', 'new_text'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'copy_file',
      description:
        'Duplicates a text file in this conversation workspace under a new flat filename, leaving the ' +
        'original untouched. Without new_name the copy is named like "report (2).md". Same limits as ' +
        'write_file. Use copy_attachment to bring a user attachment into the workspace.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Flat filename of the existing workspace file to duplicate.' },
          new_name: { type: 'string', description: 'Optional flat filename for the copy; defaults to "name (2)" with the same extension.' },
          overwrite: { type: 'boolean', description: 'Optional; default false. Explicitly allow replacing an existing file when new_name is given.' },
        },
        required: ['name'],
        additionalProperties: false,
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
    case 'read_file':
      return readFile(args, ctx);
    case 'copy_attachment':
      return copyAttachment(args, ctx);
    case 'list_files':
    case 'read_workspace_file':
    case 'write_file':
    case 'edit_file':
      return workspaceTool(name, args, ctx);
    case 'copy_file':
      return copyWorkspaceFile(args, ctx);
    case 'web_search':
      return webSearch(args, ctx);
    case 'fetch_url':
      return fetchUrl(args, ctx);
    case 'screenshot':
      return screenshot(args, ctx);
    default:
      return {
        text: untrusted('source="tool_error"', `Unknown tool "${name}". Supported tools: ${RESPONSES_TOOLS.map((tool) => tool.name).join(', ')}.`),
        label: name,
        detail: 'Unknown tool',
        failed: true,
      };
  }
}

const WORKSPACE_LABELS = {
  list_files: 'List Files',
  read_workspace_file: 'Read File',
  write_file: 'Write File',
  edit_file: 'Edit File',
};

/** Success texts end with the same instruction so the model renders the downloadable card the same way. */
function artifactHint(name) {
  return 'To show a downloadable card, put ' +
    `<artifact name="${name}"/>` +
    ' on its own line in your answer, outside code fences. The card always reads the current file contents.';
}

/** Workspace failures share one shape: a short model-facing reason, details only in the log. */
function workspaceFailure(err, label, tool) {
  if (!(err instanceof WorkspaceError)) logError('workspace_tool', err, { tool });
  return {
    text: untrusted('source="workspace"', err instanceof WorkspaceError
      ? `${err.code}: ${t(`error.${err.code}`, undefined, 'en-US')}`
      : 'Workspace operation failed.'),
    label,
    failed: true,
  };
}

function workspaceTool(name, args, { workspace }) {
  const label = WORKSPACE_LABELS[name];
  const envelope = (text) => untrusted('source="workspace"', text);
  try {
    if (name === 'list_files') {
      const files = workspace.list();
      const offset = Number.isInteger(args?.offset) ? Math.min(files.length, Math.max(0, args.offset)) : 0;
      const limit = Number.isInteger(args?.limit) ? Math.min(20, Math.max(1, args.limit)) : 20;
      const shown = files.slice(offset, offset + limit);
      const next = offset + shown.length;
      return {
        text: envelope(JSON.stringify({ files: shown, total: files.length, next_offset: next < files.length ? next : null })),
        label,
        detail: `${files.length} files`,
      };
    }
    if (name === 'read_workspace_file') {
      const body = workspace.read(args?.name);
      const out = readBody(args, { body, noun: 'file', suffix: '', label, envelope });
      return { ...out, detail: `${args.name} · ${out.detail}` };
    }
    if ((args?.overwrite !== undefined && typeof args.overwrite !== 'boolean') ||
        (args?.replace_all !== undefined && typeof args.replace_all !== 'boolean')) {
      return { text: envelope('Boolean options must be true or false.'), label, failed: true };
    }
    const file = name === 'write_file'
      ? workspace.write(args?.name, args?.content, { overwrite: args?.overwrite ?? false })
      : workspace.edit(args?.name, args?.old_text, args?.new_text, { replaceAll: args?.replace_all ?? false });
    return {
      text: envelope(`${JSON.stringify(file)}\nFile saved. ${artifactHint(file.name)}`),
      label,
      detail: file.name,
    };
  } catch (err) {
    return workspaceFailure(err, label, name);
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
    // The caption is ours, but it travels with page pixels; keep every tool result in the same envelope.
    text: untrusted('source="screenshot"', 'Viewport screenshot attached. Answer directly based on the visual content without unnecessary preamble.'),
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

  return readBody(args, {
    body,
    noun: isPdf ? 'PDF' : 'page',
    suffix: pdfPages,
    label: isPdf ? 'Read PDF' : 'Read Page',
    envelope: (text) => wrap(page, text),
  });
}

/** Shared query / offset+limit reader for the page body and uploaded documents. */
function readBody(args, { body, noun, suffix, label, envelope }) {
  const total = body.length;
  const query = typeof args?.query === 'string' ? args.query.trim() : '';
  if (query) {
    const hits = findParagraphs(body, query, 12);
    const detail = `Search ${noun}: "${query}"`;
    if (!hits.length) {
      return {
        text: envelope(`No paragraphs matching "${query}" found (${total} chars${suffix}). Consider searching without query or using alternative keywords.`),
        label,
        detail,
      };
    }

    const queryLimit = Math.min(
      Math.max(Number.isFinite(args?.limit) ? Math.trunc(args.limit) : 4000, 200),
      RESULT_CAP,
    );
    let text = `Found ${hits.length} paragraph(s) matching "${query}" in ${noun}:\n\n` + hits.join('\n\n');
    if (text.length > queryLimit) {
      text =
        text.slice(0, queryLimit) +
        `\n\n[Truncated to limit=${queryLimit}. Additional matches exist. Refine query or paginate without query via offset.]`;
    }
    text = cap(text, `Total ${total} chars${suffix}; matching paragraphs only.`);
    return { text: envelope(text), label, detail };
  }

  const rawOffset = Number.isFinite(args?.offset) ? Math.max(0, Math.trunc(args.offset)) : 0;
  const rawLimit = Number.isFinite(args?.limit) ? Math.trunc(args.limit) : 4000;
  const limit = Math.min(Math.max(rawLimit, 200), RESULT_CAP);
  const offset = Math.min(rawOffset, total);
  const slice = body.slice(offset, offset + limit);
  const end = offset + slice.length;
  const more = end < total;

  let text = `(Document range: chars ${offset + 1}–${end} of ${total}${suffix})\n\n${slice}`;
  if (more) text += `\n\n[${total - end} chars remaining. Continue with offset=${end}]`;

  return {
    text: envelope(cap(text, `Total ${total} chars${suffix}.`)),
    label,
    detail: `Chars ${offset + 1}–${end} / ${total}${suffix}`,
  };
}

/* ---------------- read_file ---------------- */

const FILE_FORMAT_LABELS = { pdf: 'PDF', docx: 'Word', xlsx: 'Excel', pptx: 'PowerPoint', text: 'text', image: 'image' };
const FILE_PAGE_UNITS = { pdf: 'pages', pptx: 'slides', xlsx: 'sheets' };

function readFile(args, { attachments }) {
  const id = typeof args?.file_id === 'string' ? args.file_id.trim() : '';
  const file = id && attachments ? attachments.get(id) : null;
  if (!file) {
    const list = attachments ? attachments.list() : [];
    const lines = list.map((a) => `- ${a.id}: ${a.name} (${FILE_FORMAT_LABELS[a.format] ?? a.format})`);
    const text = lines.length
      ? `No attachment with file_id "${id}" in this conversation. Available attachments:\n${lines.join('\n')}`
      : 'This conversation has no attachments.';
    return {
      text: untrusted('source="file_list"', text),
      label: 'Read File',
      detail: id ? `Unknown file: ${id}` : 'Missing file_id',
      failed: true,
    };
  }

  const attrs = `source="file" file_id="${escapeAttr(file.id)}" name="${escapeAttr(file.name)}"`;
  if (file.kind === 'image') {
    return {
      text: untrusted(attrs, 'This attachment is an image; it is already included in the user message. Look at it directly.'),
      label: 'Read File',
      detail: file.name,
    };
  }

  const body = file.text ?? '';
  if (!body) {
    return {
      text: untrusted(attrs, 'This attachment has no extractable text.'),
      label: 'Read File',
      detail: file.name,
      failed: true,
    };
  }

  const unit = FILE_PAGE_UNITS[file.format];
  let suffix = unit && file.pages ? ` · ${file.pages} ${unit} total` : '';
  if (file.truncated) suffix += ' · text truncated at upload';
  const out = readBody(args, {
    body,
    noun: 'file',
    suffix,
    label: 'Read File',
    envelope: (text) => untrusted(attrs, text),
  });
  return { ...out, detail: `${file.name} · ${out.detail}` };
}

/* ---------------- copy_attachment ---------------- */

const COPY_LABEL = 'Copy Attachment';

function copyAttachment(args, { attachments, workspace }) {
  const id = typeof args?.file_id === 'string' ? args.file_id.trim() : '';
  const file = id && attachments ? attachments.get(id) : null;
  if (!file) {
    const list = attachments ? attachments.list() : [];
    const lines = list.map((a) => `- ${a.id}: ${a.name} (${FILE_FORMAT_LABELS[a.format] ?? a.format})`);
    const text = lines.length
      ? `No attachment with file_id "${id}" in this conversation. Available attachments:\n${lines.join('\n')}`
      : 'This conversation has no attachments.';
    return {
      text: untrusted('source="file_list"', text),
      label: COPY_LABEL,
      detail: id ? `Unknown file: ${id}` : 'Missing file_id',
      failed: true,
    };
  }

  const envelope = (text) => untrusted('source="workspace"', text);
  const refuse = (text, detail = file.name) => ({ text: envelope(text), label: COPY_LABEL, detail, failed: true });
  // The workspace is a plain-text domain: binaries (including images) never go in, mirroring the upload
  // sniffing that stores images whole and documents as extracted text.
  if (file.kind === 'image') {
    return refuse('This attachment is an image; the workspace holds plain-text files only, and the image is already included in the user message.');
  }
  if (file.format !== 'text') {
    return refuse(`${FILE_FORMAT_LABELS[file.format] ?? file.format} attachments are binary and cannot be copied into the text workspace. Read their extracted text with read_file, or rebuild the part you need as a text file with write_file.`);
  }
  if (args?.overwrite !== undefined && typeof args.overwrite !== 'boolean') {
    return refuse('Boolean options must be true or false.', 'Invalid overwrite');
  }
  if (args?.name !== undefined && (typeof args.name !== 'string' || !args.name.trim())) {
    return refuse('name must be a nonempty filename when given.', 'Invalid name');
  }

  let text;
  try {
    // Text attachments keep their original bytes on disk; decode them the same way the upload did and
    // store as UTF-8, preserving characters and line endings rather than the normalized extract.
    text = decodeText(attachments.readBytes(file));
  } catch (err) {
    logError('workspace_tool', err, { tool: 'copy_attachment', file: file.id });
    return refuse('This attachment is missing on disk; ask the user to add it again.');
  }
  if (!text) return refuse('This attachment has no readable text.');

  try {
    const name = typeof args?.name === 'string' ? args.name.trim() : suggestName(file.name);
    const saved = workspace.write(name, text, { overwrite: args?.overwrite ?? false });
    return {
      text: envelope(`${JSON.stringify(saved)}\nCopied "${file.name}" into the workspace as ${saved.name}. ${artifactHint(saved.name)}`),
      label: COPY_LABEL,
      detail: saved.name,
    };
  } catch (err) {
    return workspaceFailure(err, COPY_LABEL, 'copy_attachment');
  }
}

/* ---------------- copy_file ---------------- */

const COPY_FILE_LABEL = 'Copy File';

/** First free "stem (2).ext" style name, fitting the same 180-byte cap the workspace enforces. */
function duplicateName(name, taken) {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot + 1) : '';
  for (let n = 2; ; n += 1) {
    let withCount = `${stem} (${n})`;
    while (Buffer.byteLength(`${withCount}.${extension}`, 'utf8') > 180 && withCount.length > 0) {
      withCount = Array.from(withCount).slice(0, -1).join('');
    }
    const candidate = extension ? `${withCount}.${extension}` : withCount;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

function copyWorkspaceFile(args, { workspace }) {
  const envelope = (text) => untrusted('source="workspace"', text);
  const refuse = (text, detail) => ({ text: envelope(text), label: COPY_FILE_LABEL, detail, failed: true });
  const source = typeof args?.name === 'string' ? args.name.trim() : '';
  if (!source) return refuse('name, the flat filename of the workspace file to duplicate, is required.', 'Missing name');
  if (args?.overwrite !== undefined && typeof args.overwrite !== 'boolean') {
    return refuse('Boolean options must be true or false.', 'Invalid overwrite');
  }
  if (args?.new_name !== undefined && (typeof args.new_name !== 'string' || !args.new_name.trim())) {
    return refuse('new_name must be a nonempty filename when given.', 'Invalid new_name');
  }

  try {
    const files = workspace.list();
    const taken = new Set(files.map((f) => f.name.toLowerCase()));
    if (!taken.has(source.toLowerCase())) {
      return refuse(JSON.stringify({ files: files.map((f) => f.name) }) +
        `\nNo workspace file named "${source}". Pick one of these, or create it with write_file first.`, `Unknown file: ${source}`);
    }
    const explicit = args?.new_name?.trim();
    // Workspace lookups are case-insensitive, so an equal name would copy a file onto itself.
    if (explicit && explicit.toLowerCase() === source.toLowerCase()) {
      return refuse('A copy needs a name different from the source file.', 'Same name');
    }
    // Workspace files are written through encode(), so read → write is a lossless byte round-trip.
    const text = workspace.read(source);
    const saved = workspace.write(explicit || duplicateName(source, taken), text, { overwrite: args?.overwrite ?? false });
    return {
      text: envelope(`${JSON.stringify(saved)}\nCopied ${source} to ${saved.name}; the original is untouched. ${artifactHint(saved.name)}`),
      label: COPY_FILE_LABEL,
      detail: saved.name,
    };
  } catch (err) {
    return workspaceFailure(err, COPY_FILE_LABEL, 'copy_file');
  }
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
    await assertPublicHttpUrl(url);
  } catch (err) {
    throw new ToolError(400, `URL not allowed: ${err?.message ?? err}`);
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

  await assertPublicHttpUrl(url);
  const timeout = AbortSignal.timeout(30_000);
  const stop = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let res;
  try {
    res = await fetchPublic(url, { headers: { Accept: 'application/pdf,*/*' }, signal: stop });
  } catch (err) {
    if (timeout.aborted) throw new ToolError(504, 'Fetching PDF timed out after 30s');
    throw err;
  }
  if (!res.ok) throw new ToolError(res.status, `Failed to fetch PDF: HTTP ${res.status}`);
  const buf = await readBodyCapped(res, 64 * 1024 * 1024);

  const out = await extractPdfText(buf, { signal });
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
  // Attrs are our own markup, but titles/URLs are page-controlled. Keep the envelope bounded so a huge
  // title cannot consume the whole tool budget before the body is even considered.
  const shown = String(attrs ?? '');
  const safeAttrs = shown.length <= 600 ? shown : `${shown.slice(0, 597)}...`;
  const prefix = `<untrusted_content ${safeAttrs}>\n`;
  const close = '\n</untrusted_content>';
  const body = String(text ?? '').replace(/<(\/?\s*untrusted_content)/gi, '&lt;$1');
  const budget = RESULT_CAP - prefix.length - close.length;
  if (body.length <= budget) return `${prefix}${body}${close}`;
  // The cap is on the final tool message, envelope included; otherwise the model-facing text is > RESULT_CAP.
  const suffix = `\n\n[Truncated: output limited to ${RESULT_CAP} chars including envelope. Narrow the query or range to retrieve more.]`;
  const room = Math.max(0, budget - suffix.length);
  return `${prefix}${body.slice(0, room)}${suffix}${close}`;
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
    let detail = '';
    try {
      detail = (await readBodyCapped(res, 64 * 1024)).toString('utf8');
    } catch {
      /* oversized/broken error body: the status still tells the story */
    }
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