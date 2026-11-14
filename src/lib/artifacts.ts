import { authHeaders, backendErrorText, endpoint } from './chat';
import { t } from './i18n';
import { baseUrl, type Settings } from './settings';
import { artifactCodeLanguage, artifactPreviewKind, parseDelimitedPreview } from './artifact-preview.mjs';

/** Opt-in context supplied only for assistant answers, never user messages or tool output. */
export interface ArtifactContext {
  settings: Settings;
  conversationId: string;
  showToast: (message: string) => void;
  /** Insert a file reference chip (stored as <pageask-file>) naming the artifact into the composer */
  quoteFile: (name: string) => void;
}

export type ArtifactPreviewContent =
  | { kind: 'html'; source: string }
  | { kind: 'markdown'; source: string }
  | { kind: 'table'; headers: string[]; rows: string[][]; truncated: boolean }
  | { kind: 'code'; highlighted: string | null; source: string; limited: boolean };

export async function buildArtifactPreview(name: string, text: string): Promise<ArtifactPreviewContent> {
  const kind = artifactPreviewKind(name);
  if (kind === 'html') return { kind, source: artifactPreviewDocument(text) };
  if (kind === 'markdown') return { kind, source: text };
  if (kind === 'table') {
    return { kind, ...parseDelimitedPreview(text, /\.tsv$/i.test(name) ? '\t' : ',') };
  }
  const language = artifactCodeLanguage(name);
  if (!language) return { kind: 'code', highlighted: null, source: text, limited: false };
  const { default: highlight } = await import('highlight.js/lib/common');
  if (language === 'latex' && !highlight.getLanguage(language)) {
    const { default: latex } = await import('highlight.js/lib/languages/latex');
    highlight.registerLanguage(language, latex);
  }
  // Bound grammar work without splitting a surrogate pair or hiding the original contents.
  let end = Math.min(text.length, 100_000);
  const last = text.charCodeAt(end - 1);
  if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
  const prefix = text.slice(0, end);
  return {
    kind: 'code',
    highlighted: highlight.highlight(prefix, { language, ignoreIllegals: true }).value,
    source: text.slice(prefix.length),
    limited: prefix.length < text.length,
  };
}

export async function fetchArtifact(
  { settings, conversationId }: ArtifactContext,
  name: string,
  signal: AbortSignal,
): Promise<Blob> {
  try {
    const path = `/conversations/${encodeURIComponent(conversationId)}/files/${encodeURIComponent(name)}/content`;
    const response = await fetch(endpoint(settings, path), { headers: authHeaders(settings), signal });
    if (!response.ok) throw new Error(await backendErrorText(response));
    return await response.blob();
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name !== 'TypeError')) throw error;
    throw new Error(t('error.unreachable', { baseUrl: baseUrl(settings) }));
  }
}

const PREVIEW_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; script-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'";
const STATIC_TAGS = new Set((
  'html head body title style main article section header footer nav aside div span p br hr h1 h2 h3 h4 h5 h6 ' +
  'b strong i em u s small sub sup mark code pre kbd samp var blockquote q cite abbr address time ' +
  'ul ol li dl dt dd table caption colgroup col thead tbody tfoot tr th td figure figcaption img a ' +
  'details summary ruby rt rp wbr'
).split(' '));
const STATIC_ATTRS = new Set((
  'class id title style lang dir alt width height colspan rowspan scope start reversed value open'
).split(' '));

// CSP alone does not block self-navigation; inert parsing strips every navigation surface before preview.
export function artifactPreviewDocument(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  for (const element of Array.from(template.content.querySelectorAll('*'))) {
    const tag = element.localName;
    if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml' || !STATIC_TAGS.has(tag)) {
      element.remove();
      continue;
    }
    for (const attribute of Array.from(element.attributes)) {
      const dataImage = tag === 'img' && attribute.name === 'src' &&
        /^data:image\/(?:png|jpeg|gif|webp|avif|bmp);base64,[a-z0-9+/=\s]+$/i.test(attribute.value);
      if (!STATIC_ATTRS.has(attribute.name) && !dataImage) element.removeAttribute(attribute.name);
    }
  }
  // Place our policy first; all supplied meta/base/link/script/frame/form/SVG elements were removed.
  return `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"><meta charset="utf-8">${template.innerHTML}`;
}
