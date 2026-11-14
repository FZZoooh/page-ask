// text helpers: for read_page's "find paragraphs by keyword".
// no perfect chunking needed — just split long text into semantic blocks and give hits some context.

/**
 * Find paragraphs in a Markdown body that contain query.
 * @param {string} body page text
 * @param {string} query keyword (case-insensitive)
 * @param {number} max how many paragraphs to return at most
 * @returns {string[]} matching paragraphs (short noise lines already dropped)
 */
export function findParagraphs(body, query, max = 12) {
  const needle = query.toLowerCase();
  const blocks = body
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);

  const hits = [];
  for (const block of blocks) {
    if (!block.toLowerCase().includes(needle)) continue;
    // a huge block (e.g. the whole page with no blank lines) is excerpted, so one hit can't eat the budget
    const text = block.length > 1200 ? excerpt(block, needle, 1200) : block;
    hits.push(text);
    if (hits.length >= max) break;
  }
  return hits;
}

export function findSelectionRange(body, text, selectionContext) {
  if (!text) return null;
  const pattern = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const selected = `(?<selected>${pattern(text)})`;
  const patterns = [];
  const ctx = selectionContext?.context;
  const start = selectionContext?.start;
  const end = selectionContext?.end;
  if (
    typeof ctx === 'string' && Number.isInteger(start) && Number.isInteger(end) &&
    start >= 0 && end > start && end <= ctx.length && ctx.slice(start, end) === text
  ) {
    patterns.push(pattern(ctx.slice(0, start)) + selected + pattern(ctx.slice(end)));
  }
  patterns.push(selected);
  for (const source of patterns) {
    const regex = new RegExp(source, 'dg');
    const match = regex.exec(body);
    if (!match) continue;
    // Check overlapping matches too; a repeated selection must never silently pick the first occurrence.
    regex.lastIndex = match.index + 1;
    if (regex.exec(body)) continue;
    const [offset, end] = match.indices.groups.selected;
    return { offset, end };
  }
  return null;
}

/** take a slice centred on the match inside a long block */
function excerpt(block, needle, size) {
  const at = block.toLowerCase().indexOf(needle);
  if (at < 0) return block.slice(0, size);
  const half = Math.floor(size / 2);
  const start = Math.max(0, at - half);
  const end = Math.min(block.length, start + size);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < block.length ? '…' : '';
  return prefix + block.slice(start, end) + suffix;
}

/**
 * Plain text in UTF-8 / UTF-16 (BOM) / GB18030. Returns null for binary: NUL bytes outside UTF-16,
 * or a GB18030 decode full of control characters (that decoder accepts almost any byte sequence).
 * Lives here (not in attachments.mjs) so tool code can decode stored text without pulling the
 * attachment/db module graph into the tool layer.
 */
export function decodeText(b) {
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
