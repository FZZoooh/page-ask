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
