// Incremental Markdown for streaming answers.
//
// Parsing the whole answer on every 50ms flush is O(n²) and makes KaTeX re-run for every token.
// We split the text into completed blocks (safe to memoize) plus a tail that has not reached a
// blank-line boundary yet. The tail is rendered as plain text, so an open code fence or $$ block
// never reaches remark/KaTeX in a half-written state.

const FENCE = /^(`{3,}|~{3,})/;
const LIST_OR_QUOTE = /^\s*(?:[-*+] |\d+[.)] |>)/;

function fenceAt(trimmed) {
  const match = FENCE.exec(trimmed);
  return match ? match[1] : null;
}

function startsMath(trimmed) {
  if (!trimmed.startsWith('$$')) return false;
  const markers = (trimmed.match(/\$\$/g) ?? []).length;
  return markers % 2 === 1;
}

function isListLike(block) {
  const first = block.split('\n').find((line) => line.trim()) ?? '';
  return LIST_OR_QUOTE.test(first);
}

function isContinuation(block) {
  if (isListLike(block)) return true;
  const first = block.split('\n').find((line) => line.trim()) ?? '';
  // An indented paragraph is a loose-list continuation more often than a new block.
  return /^\s{2,}\S/.test(first);
}

function splitBlocks(stable) {
  const blocks = [];
  let current = [];
  let fence = null;
  let inMath = false;

  const flush = () => {
    if (!current.some((line) => line.trim())) {
      current = [];
      return;
    }
    // Do not trim the left edge: code blocks and nested list items rely on it.
    blocks.push(current.join('\n').replace(/^\n+|\n+$/g, ''));
    current = [];
  };

  for (const line of stable.split('\n')) {
    const trimmed = line.trim();

    if (fence) {
      current.push(line);
      if (trimmed.startsWith(fence)) fence = null;
      continue;
    }
    if (inMath) {
      current.push(line);
      if (line.includes('$$')) inMath = false;
      continue;
    }

    const nextFence = fenceAt(trimmed);
    if (nextFence) {
      current.push(line);
      fence = nextFence;
      continue;
    }
    if (trimmed.startsWith('$$')) {
      current.push(line);
      if (startsMath(trimmed)) inMath = true;
      continue;
    }
    if (!trimmed) {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();

  // A blank line inside a loose list (or between list and its indented continuation) must not
  // restart numbering or split one list into two.
  const merged = [];
  for (const block of blocks) {
    const prev = merged[merged.length - 1];
    if (prev !== undefined && isListLike(prev) && isContinuation(block)) {
      merged[merged.length - 1] = `${prev}\n\n${block}`;
    } else {
      merged.push(block);
    }
  }
  return merged;
}

/**
 * @param {string} text
 * @returns {{ blocks: string[], tail: string }}
 */
export function splitStreamingMarkdown(text) {
  let boundary = 0;
  let fence = null;
  let inMath = false;
  let pos = 0;

  while (pos < text.length) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(pos, end);
    const trimmed = line.trim();

    if (fence) {
      if (trimmed.startsWith(fence)) fence = null;
    } else if (inMath) {
      if (line.includes('$$')) inMath = false;
    } else {
      const nextFence = fenceAt(trimmed);
      if (nextFence) {
        fence = nextFence;
      } else if (trimmed.startsWith('$$')) {
        if (startsMath(trimmed)) inMath = true;
      } else if (!trimmed) {
        // Keep the newline so the completed prefix ends exactly at a block boundary.
        boundary = nl === -1 ? text.length : nl + 1;
      }
    }

    pos = nl === -1 ? text.length : nl + 1;
  }

  return {
    blocks: splitBlocks(text.slice(0, boundary)),
    tail: text.slice(boundary),
  };
}
