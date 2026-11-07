// 文本小工具：给 read_page 的「按关键词找段落」用。
// 不追求完美切分，只要能把长文按语义块切出来、命中段落带点上下文就够。

/**
 * 在 Markdown 正文里找包含 query 的段落。
 * @param {string} body 正文
 * @param {string} query 关键词（不区分大小写）
 * @param {number} max 最多返回几段
 * @returns {string[]} 命中段落（已去掉过短的噪音行）
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
    // 超长块（比如整篇没有空行）截一段上下文，避免一条命中就吃满预算
    const text = block.length > 1200 ? excerpt(block, needle, 1200) : block;
    hits.push(text);
    if (hits.length >= max) break;
  }
  return hits;
}

/** 在长块里以命中位置为中心取一段 */
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
