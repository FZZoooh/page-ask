// Incremental Markdown for streaming answers.
//
// Parsing the whole answer on every 50ms flush is O(n²) and makes KaTeX re-run for every token.
// We split the text into completed blocks (safe to memoize) plus a tail that has not reached a
// blank-line boundary yet. The tail is re-parsed on every flush and rendered as live Markdown:
// CommonMark defines unclosed fences/tables/lists as blocks running to end of input, so they
// parse to well-formed partial blocks. The one exception is an open $$ flow, which would feed
// half-written TeX to KaTeX — `tailPlain` reports that shape so the caller keeps it plain text.

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
 * Rewrite `$$…$$` pairs so each delimiter sits alone on its line.
 *
 * remark-math 6 only parses display math in that shape: `$$formula…` makes it treat the opening
 * line as text and keep the trailing `$$` inside the formula, which then reaches KaTeX as a syntax
 * error; a closing `$$` followed by text can swallow the rest of the answer. Models emit both
 * shapes constantly, so normalize before handing the block to remark. Fenced code and inline code
 * are skipped: dollar signs there are content, not delimiters.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeDisplayMath(text) {
  return mapOutsideFences(text, (plain) => mapOutsideInlineCode(plain, rewriteMathPairs));
}

function mapOutsideFences(text, transform) {
  const lines = text.split('\n');
  const out = [];
  let plain = [];

  const flush = () => {
    if (!plain.length) return;
    out.push(transform(plain.join('\n')));
    plain = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (!open) {
      plain.push(line);
      i += 1;
      continue;
    }

    flush();
    const fenceChar = open[1][0];
    const fenceLength = open[1].length;
    const code = [line];
    i += 1;
    while (i < lines.length) {
      const current = lines[i];
      code.push(current);
      i += 1;
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(current);
      if (close && close[1][0] === fenceChar && close[1].length >= fenceLength) break;
    }
    out.push(code.join('\n'));
  }

  flush();
  return out.join('\n');
}

function mapOutsideInlineCode(text, transform) {
  const out = [];
  let plain = '';
  let i = 0;

  while (i < text.length) {
    if (text[i] !== '`') {
      plain += text[i];
      i += 1;
      continue;
    }

    let run = 0;
    while (text[i + run] === '`') run += 1;
    let j = i + run;
    let close = -1;
    while (j < text.length) {
      if (text[j] !== '`') {
        j += 1;
        continue;
      }
      let length = 0;
      while (text[j + length] === '`') length += 1;
      if (length === run) {
        close = j;
        break;
      }
      j += length;
    }

    // An unmatched run is literal text; carry it through untouched.
    if (close === -1) {
      plain += text.slice(i, i + run);
      i += run;
      continue;
    }

    if (plain) {
      out.push(transform(plain));
      plain = '';
    }
    out.push(text.slice(i, close + run));
    i = close + run;
  }

  if (plain) out.push(transform(plain));
  return out.join('');
}

function rewriteMathPairs(text) {
  const out = [];
  let last = 0;
  let i = 0;

  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] !== '$' || text[i + 1] !== '$') {
      i += 1;
      continue;
    }

    // Only a line-leading `$$` can start display-math flow. Mid-line pairs are parsed as inline
    // math and render correctly, so touching them would only reflow the sentence around them.
    const lineStart = text.lastIndexOf('\n', i - 1) + 1;
    if (!/^ {0,3}$/.test(text.slice(lineStart, i))) {
      i += 2;
      continue;
    }

    let j = i + 2;
    let close = -1;
    while (j < text.length) {
      if (text[j] === '\\') {
        j += 2;
        continue;
      }
      if (text[j] === '$' && text[j + 1] === '$') {
        close = j;
        break;
      }
      j += 1;
    }
    if (close === -1) break;

    // Trim only the newlines the old delimiter style may have left around the body; interior
    // newlines are meaningful to aligned/display math and must be preserved.
    const body = text.slice(i + 2, close).replace(/^\n+|\n+$/g, '');
    // `$$x$$` alone on a line is display math semantically, but remark parses it as inline math
    // when the content is attached to the delimiters — the formula then renders at inline size,
    // visibly smaller than a neighbouring multi-line display block. Always rewrite a line-leading
    // pair into the three-line form so every display formula looks the same. Content after the
    // closing delimiter also needs a line break, otherwise the flow construct runs past it.
    const trailing = !/^[ \t]*(?:\r?\n|$)/.test(text.slice(close + 2));

    out.push(text.slice(last, i), '$$\n', body, '\n$$');
    last = close + 2;
    i = close + 2;
    if (trailing) out.push('\n');
  }

  out.push(text.slice(last));
  return out.join('');
}

/**
 * @param {string} text
 * @returns {{ blocks: string[], tail: string, tailPlain: boolean }}
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
    // An open $$ flow parses to end of input (remark-math), unlike fences/tables which end at a
    // well-defined partial block; KaTeX must not see half-written TeX on every flush.
    tailPlain: inMath,
  };
}
