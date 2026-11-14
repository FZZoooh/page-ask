/**
 * Icons for buttons. Shared 16×16 viewBox and `currentColor`; size comes from CSS `.icon`.
 * All carry aria-hidden: the button's own aria-label supplies the accessible name, so screen readers speak it once.
 */

type Props = { className?: string };

const base = {
  className: 'icon',
  viewBox: '0 0 16 16',
  width: 16,
  height: 16,
  'aria-hidden': true,
  focusable: false,
} as const;

/** Disclosure triangle: points right when collapsed; CSS rotates it 90° down when open */
export function IconChevron({ open }: { open?: boolean }) {
  return (
    <svg {...base} className={`icon chevron${open ? ' open' : ''}`}>
      <path d="M6 4.2 10.4 8 6 11.8Z" fill="currentColor" />
    </svg>
  );
}

/** Oversized opening quotation mark */
export function IconQuote(_props: Props) {
  return (
    <svg {...base}>
      <path
        d="M7.1 3.4c-2.3 1-3.6 3-3.6 5.6V12h4.2V7.9H5.3c.1-1.5.8-2.6 2.1-3.4zM13.6 3.4c-2.3 1-3.6 3-3.6 5.6V12h4.2V7.9h-2.4c.1-1.5.8-2.6 2.1-3.4z"
        fill="currentColor"
      />
    </svg>
  );
}

/** Heavy double opening quote drawn after the reference art: solid 66 shapes with a domed tip at
 * the top right, a long sweep down-left into a solid block, and the crook opening to the right.
 * Deviates from the shared 16×16 base on purpose: the glyph keeps the art's proportions (with the
 * inter-mark gap tightened from the art's 0.58 mark-widths to ~0.28), is sized by CSS
 * (.sel-hint-mark renders it at letter height), and must not inherit the 16px .icon size. */
export function IconQuoteMark({ className }: { className: string }) {
  const d =
    'M76 3C78 0 84 0 86 3L89 13 93 21 97 29 101 37 101 41 93 45 76 53 66 61 59 69 55 77 52 85 50 93 49 101 49 111 93 113 93 205 0 205 0 111L2 101 3 93 5 85 7 77 9 69 13 61 18 53 23 45 30 37 38 29 48 21 60 13Z';
  return (
    <svg className={className} viewBox="0 0 230 206" width={230} height={206} aria-hidden="true" focusable={false}>
      <path d={d} fill="currentColor" />
      <path d={d} fill="currentColor" transform="translate(129 0)" />
    </svg>
  );
}

/** Send: arrow pointing up */
export function IconSend(_props: Props) {
  return (
    <svg {...base} stroke="currentColor" strokeWidth={1.8} fill="none">
      <path d="M8 13V3.6" strokeLinecap="round" />
      <path d="M4.2 7.2 8 3.4l3.8 3.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconExpand({ expanded }: { expanded: boolean }) {
  return (
    <svg {...base} stroke="currentColor" strokeWidth={1.4} fill="none">
      <path
        d={expanded ? 'M13 3 9.5 6.5m0-3.5v3.5H13M3 13l3.5-3.5M3 9.5h3.5V13' : 'M9 7l4-4m-4 0h4v4M7 9l-4 4m0-4v4h4'}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Stop: rounded square */
export function IconStop(_props: Props) {
  return (
    <svg {...base}>
      <rect x="3.6" y="3.6" width="8.8" height="8.8" rx="2.2" fill="currentColor" />
    </svg>
  );
}

/** Copy: two stacked rounded squares */
export function IconCopy(_props: Props) {
  return (
    <svg {...base} stroke="currentColor" strokeWidth={1.4} fill="none">
      <rect x="2.4" y="2.4" width="8" height="8" rx="2" />
      <path d="M5.8 13.6h5.8a2 2 0 0 0 2-2V5.8" strokeLinecap="round" />
    </svg>
  );
}

/** Edit: pencil pointing down-left, with a band line near the eraser end */
export function IconEdit(_props: Props) {
  return (
    <svg {...base} stroke="currentColor" strokeWidth={1.4} fill="none">
      <path d="M11.3 2a1.9 1.9 0 0 1 2.7 2.7L5 13.7l-3.7 1 1-3.7L11.3 2Z" strokeLinejoin="round" />
      <path d="m9.9 3.4 2.7 2.7" strokeLinecap="round" />
    </svg>
  );
}

/** Regenerate: circular arrow */
export function IconReload(_props: Props) {
  return (
    <svg {...base} stroke="currentColor" strokeWidth={1.4} fill="none">
      <path d="M13 8a5 5 0 1 1-1.6-3.7" strokeLinecap="round" />
      <path d="M13.2 2.4v2.9h-2.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Scroll to the newest message when the list is no longer following the bottom */
export function IconArrowDown(_props: Props) {
  return (
    <svg {...base} stroke="currentColor" strokeWidth={1.7} fill="none">
      <path d="M8 3v9.6" strokeLinecap="round" />
      <path d="m4.2 9.2 3.8 3.8 3.8-3.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Done (brief confirmation after a successful copy) */
export function IconCheck(_props: Props) {
  return (
    <svg {...base} stroke="currentColor" strokeWidth={1.8} fill="none">
      <path d="M3 8.4 6.4 11.8 13 5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Attach: plus sign */
export function IconPlus(_props: Props) {
  return (
    <svg {...base} stroke="currentColor" strokeWidth={1.7} fill="none">
      <path d="M8 3v10M3 8h10" strokeLinecap="round" />
    </svg>
  );
}

/** Remove: small cross */
export function IconClose(_props: Props) {
  return (
    <svg {...base} stroke="currentColor" strokeWidth={1.8} fill="none">
      <path d="m4.4 4.4 7.2 7.2M11.6 4.4l-7.2 7.2" strokeLinecap="round" />
    </svg>
  );
}

export function IconDownload(_props: Props) {
  return (
    <svg {...base} stroke="currentColor" strokeWidth={1.5} fill="none">
      <path d="M8 2.2v7.4m-2.8-2.8L8 9.6l2.8-2.8M3 10.5v2.3a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const FILE_ICON_KINDS: Record<string, string> = {
  md: 'markdown', markdown: 'markdown',
  html: 'html', htm: 'html', xml: 'html',
  css: 'style',
  json: 'json',
  csv: 'table', tsv: 'table', sql: 'table',
  yaml: 'config', yml: 'config', toml: 'config', ini: 'config',
  js: 'code', mjs: 'code', jsx: 'code', ts: 'code', tsx: 'code', py: 'code',
  rs: 'code', go: 'code', java: 'code', c: 'code', cpp: 'code', h: 'code',
};

/** The white glyph drawn inside the badge; coordinates assume the 30×25 badge at (14,34).
 *  IconAttachmentFile scales the group up and drops it straight onto the tinted sheet. */
function fileBadgeMark(kind: string, transform?: string) {
  return (
    <g className="artifact-mark" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" transform={transform}>
      {kind === 'markdown' && <path d="M19 51V42l4 5 4-5v9m9-9v9m-3-3 3 3 3-3" />}
      {(kind === 'html' || kind === 'code') && <path d="m23 42-4 4.5 4 4.5m12-9 4 4.5-4 4.5m-5-10-3 11" />}
      {kind === 'style' && <path d="m26 40-2 13m10-13-2 13m-11-9h16m-17 5h16" />}
      {kind === 'json' && <path d="M25 40h-2v4l-3 2.5 3 2.5v4h2m8-13h2v4l3 2.5-3 2.5v4h-2" />}
      {kind === 'table' && <>
        <rect x="20" y="40" width="18" height="13" rx="1" />
        <path d="M20 44h18m-18 4.5h18m-12-8.5v13" />
      </>}
      {kind === 'config' && <>
        <path d="M20 42h18m-18 9h18" />
        <circle cx="25" cy="42" r="2" className="artifact-knob" />
        <circle cx="33" cy="51" r="2" className="artifact-knob" />
      </>}
      {kind === 'slide' && <path d="M26 41v10l9-5Z" />}
      {kind === 'image' && <>
        <rect x="20" y="39" width="18" height="15" rx="2" />
        <circle cx="24.5" cy="43.5" r="1.8" className="artifact-knob" />
        <path d="m21.5 51.5 4.5-4.5 3 3 3-3.5 4.5 4.5" />
      </>}
      {kind === 'text' && <path d="M21 41h16m-16 5.5h16M21 52h11" />}
    </g>
  );
}

export function IconArtifactFile({ extension }: { extension: string }) {
  const kind = FILE_ICON_KINDS[extension.toLowerCase()] ?? 'text';
  return (
    <svg className="artifact-file" viewBox="0 0 60 78" width="60" height="78" aria-hidden="true" focusable="false" data-kind={kind}>
      <path className="artifact-paper" d="M8 2h28l18 18v54a3 3 0 0 1-3 3H8a5 5 0 0 1-5-5V7a5 5 0 0 1 5-5Z" />
      <path className="artifact-fold" d="M36 2v13a5 5 0 0 0 5 5h13Z" />
      <rect className="artifact-badge" x="14" y="34" width="30" height="25" rx="2.5" />
      {fileBadgeMark(kind)}
    </svg>
  );
}

/** Formats without a per-extension glyph map straight to one; text files go through FILE_ICON_KINDS */
const ATT_FORMAT_KINDS: Record<string, string> = {
  pdf: 'text', docx: 'text', xlsx: 'table', pptx: 'slide', image: 'image', file: 'text',
};

/** Attachment card icon: the artifact sheet drawn at 36px card size. The whole sheet takes the
 *  format tint and the white glyph sits straight on it (paper and badge share one color, no
 *  boundary), so the badge rect is gone; the glyph keeps the badge position, scaled by 4/3 around
 *  its center — translate(c*(1-s)) scale(s), c = (29, 46.5), s = 4/3 — because at this size the
 *  original marks are too small to read. The fold spans 22 units, proportionally a bit larger
 *  than the artifact's 18, which nearly disappears at this scale. */
export function IconAttachmentFile({ format, name }: { format: string; name: string }) {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  const kind = format === 'text'
    ? (FILE_ICON_KINDS[ext] ?? 'text')
    : (ATT_FORMAT_KINDS[format] ?? 'text');
  return (
    <svg className="att-file" viewBox="0 0 60 78" aria-hidden="true" focusable="false" data-format={format}>
      <path className="artifact-paper" d="M8 2h24l22 22v50a3 3 0 0 1-3 3H8a5 5 0 0 1-5-5V7a5 5 0 0 1 5-5Z" />
      <path className="artifact-fold" d="M32 2v17a5 5 0 0 0 5 5h17Z" />
      {fileBadgeMark(kind, 'translate(-9.67 -15.5) scale(1.3333)')}
    </svg>
  );
}
