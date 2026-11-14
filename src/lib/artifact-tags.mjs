// Only this exact, standalone protocol line can become a file card. Raw HTML is never rendered.
export function artifactName(line) {
  const match = /^ {0,3}<artifact name="([^"<>\x00-\x1f\x7f]+)"\/>[ \t]*\r?$/.exec(line);
  const name = match?.[1];
  return name && name !== '.' && name !== '..' && !/[\\/]/.test(name) ? name : null;
}

function card(name) {
  return {
    type: 'artifact',
    children: [],
    data: { hName: 'div', hProperties: { 'data-artifact-name': name } },
  };
}

function standalone(node, source) {
  const offset = node.position?.start.offset;
  if (offset === undefined) return null;
  const start = source.lastIndexOf('\n', offset - 1) + 1;
  const end = source.indexOf('\n', offset);
  return artifactName(source.slice(start, end === -1 ? source.length : end));
}

const VOID_HTML = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
const RAW_HTML = new Set(['script', 'pre', 'style', 'textarea']);
const HTML_TOKENS = /<!--|-->|<\?|\?>|<!\[CDATA\[|\]\]>|<![A-Z]|<(\/?)([a-z][\w-]*)(?:\s+(?:[^"'<>]|"[^"]*"|'[^']*')*)?\s*(\/?)>|>/gi;
const HTML_ENDINGS = { '!comment': '-->', '!pi': '?>', '!cdata': ']]>', '!declaration': '>' };
function updateHtmlContext(value, stack) {
  // CommonMark ends some HTML blocks at a blank line, even if the actual container is still open.
  // Remember comments too: a fake closing tag inside one must not reopen artifact recognition.
  for (const match of value.matchAll(HTML_TOKENS)) {
    const token = match[0];
    const top = stack.at(-1);
    const name = match[2]?.toLowerCase();
    if (RAW_HTML.has(top) && !(match[1] && name === top)) continue;
    if (HTML_ENDINGS[top]) {
      if (token === HTML_ENDINGS[top]) stack.pop();
      continue;
    }
    if (!name) {
      if (token === '<!--') stack.push('!comment');
      else if (token === '<?') stack.push('!pi');
      else if (token === '<![CDATA[') stack.push('!cdata');
      else if (token.startsWith('<!')) stack.push('!declaration');
      continue;
    }
    if (match[1]) {
      const index = stack.lastIndexOf(name);
      if (index !== -1) stack.length = index;
    } else if (!match[3] && !/\/>$/.test(token) && !VOID_HTML.has(name)) {
      stack.push(name);
    }
  }
}

// Reparse before remark transforms: protocol lines otherwise swallow following Markdown as raw HTML.
export function remarkArtifactTags() {
  const processor = this;
  return (tree, file) => {
    let source = String(file);
    let parsed = tree;
    let marker = 'RHMARTIFACTMARKER';
    while (source.includes(marker)) marker += 'X';
    const names = [];
    for (;;) {
      let candidate = null;
      const htmlContext = [];
      for (const node of parsed.children) {
        if (node.type === 'html') {
          const first = node.value.split('\n', 1)[0];
          const name = artifactName(first);
          if (!htmlContext.length && name && standalone(node, source) === name) candidate = node;
          if (!candidate) updateHtmlContext(node.value, htmlContext);
        } else if (node.type === 'paragraph') {
          // Inline HTML wrappers are raw content too; do not extract anything from inside one.
          const html = node.children.filter((child) => child.type === 'html');
          if (!htmlContext.length && html.length &&
              html.every((child) => artifactName(child.value) && standalone(child, source))) {
            candidate = html[0];
          }
          if (!candidate) for (const child of html) updateHtmlContext(child.value, htmlContext);
        }
        if (candidate) break;
      }
      if (!candidate) break;
      const offset = candidate.position.start.offset;
      const start = source.lastIndexOf('\n', offset - 1) + 1;
      let end = start;
      const replacements = [];
      // Adjacent cards (with optional blank separators) have no intervening parser context. Batch
      // them so a long generated file list does not reparse once per filename.
      while (end < source.length) {
        const newline = source.indexOf('\n', end);
        const lineEnd = newline === -1 ? source.length : newline;
        const line = source.slice(end, lineEnd);
        const name = artifactName(line);
        if (name) {
          replacements.push(`${marker}${names.length}`);
          names.push(name);
        } else if (line.trim()) {
          break;
        }
        end = newline === -1 ? source.length : newline + 1;
      }
      source = `${source.slice(0, start)}\n\n${replacements.join('\n\n')}\n\n${source.slice(end)}`;
      parsed = processor.parse(source);
    }
    if (!names.length) return;
    tree.children = parsed.children.map((node) => {
      if (node.type !== 'paragraph' || node.children.length !== 1 || node.children[0].type !== 'text') return node;
      const value = node.children[0].value;
      if (!value.startsWith(marker)) return node;
      const index = Number(value.slice(marker.length));
      return Number.isInteger(index) && names[index] && value === `${marker}${index}` ? card(names[index]) : node;
    });
  };
}

// CommonMark HTML blocks 1–7. Types 1–5 can span blank lines; 6–7 end at the next blank line.
const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const BLOCK_HTML = new RegExp(`^</?(?:${BLOCK_TAGS})(?:[ \\t/>]|$)`, 'i');
const COMPLETE_HTML = /^<\/?[a-z][\w-]*(?:\s+[a-z_:][\w.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>\s*$/i;

function htmlEnd(line, atBoundary) {
  const raw = line.trimStart();
  const tag = /^<(script|pre|style|textarea)(?:[ \t>]|$)/i.exec(raw)?.[1];
  if (tag) return new RegExp(`</${tag}\\s*>`, 'i');
  if (raw.startsWith('<!--')) return /-->/;
  if (raw.startsWith('<?')) return /\?>/;
  if (raw.startsWith('<![CDATA[')) return /\]\]>/;
  if (/^<![A-Z]/.test(raw)) return />/;
  if (BLOCK_HTML.test(raw)) return 'blank';
  if (atBoundary && !artifactName(line) && COMPLETE_HTML.test(raw)) return 'blank';
  return null;
}

const LIST = /^\s*(?:[-*+] |\d+[.)] |>)/;
function firstLine(block) {
  return block.split('\n').find((line) => line.trim()) ?? '';
}

// Preserve raw/code context across blank lines so streaming never promotes an enclosed tag to a card.
export function splitArtifactMarkdown(text) {
  const blocks = [];
  let current = '';
  let fence = null;
  let html = null;
  const htmlContext = [];
  let math = false;
  let mathStart = 0;
  let indented = false;
  let pos = 0;
  const flush = () => {
    const block = current.replace(/^\n+|\n+$/g, '');
    current = '';
    if (!block.trim()) return;
    const previous = blocks.at(-1);
    const first = firstLine(block);
    if (previous && LIST.test(firstLine(previous)) && (LIST.test(first) || /^\s{2,}\S/.test(first))) {
      blocks[blocks.length - 1] = `${previous}\n\n${block}`;
    } else {
      blocks.push(block);
    }
  };

  while (pos < text.length) {
    const newline = text.indexOf('\n', pos);
    const end = newline === -1 ? text.length : newline;
    const line = text.slice(pos, end);
    const blank = !line.trim();
    const complete = newline !== -1;
    const raw = text.slice(pos, complete ? end + 1 : end);
    pos = complete ? end + 1 : end;

    if (fence) {
      current += raw;
      const close = /^\s*(`{3,}|~{3,})[ \t]*\r?$/.exec(line)?.[1];
      if (close && close[0] === fence[0] && close.length >= fence.length) fence = null;
      continue;
    }
    if (html) {
      updateHtmlContext(line, htmlContext);
      current += raw;
      if (html === 'blank' ? blank : html.test(line)) {
        html = null;
        if (blank && complete && !htmlContext.length) flush();
      }
      continue;
    }
    if (math) {
      current += raw;
      if (line.includes('$$')) math = false;
      continue;
    }
    if (indented) {
      if (blank || /^(?: {4}|\t)/.test(line)) {
        current += raw;
        continue;
      }
      // The preceding blank already closed the code block, not the unindented following line.
      if (/\n[ \t\r]*\n$/.test(current)) flush();
      indented = false;
    }

    const nextFence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    const nextHtml = htmlEnd(line, !current.trim());
    if (nextFence && (nextFence[1][0] !== '`' || !nextFence[2].includes('`'))) {
      fence = nextFence[1];
    } else if (nextHtml) {
      updateHtmlContext(line, htmlContext);
      if (nextHtml === 'blank' || !nextHtml.test(line)) html = nextHtml;
    } else if (!current.trim() && /^(?: {4}|\t)/.test(line)) {
      indented = true;
    } else if (line.trimStart().startsWith('$$')) {
      math = (line.match(/\$\$/g) ?? []).length % 2 === 1;
      // The opener line is not appended to `current` until below, so its tail offset is exact.
      if (math) mathStart = current.length;
    } else if (!blank) {
      // Literal HTML in inline code or an escape must not hold all subsequent streaming blocks.
      const plain = line.replace(/\\[\\`<]/g, '').replace(/(^|[^`])(`+)(?!`)(.*?)\2(?!`)/g, '$1');
      updateHtmlContext(plain, htmlContext);
    }
    current += raw;
    if (blank && complete && !fence && !html && !math && !indented && !htmlContext.length) flush();
  }
  // Same guard as splitStreamingMarkdown: an open $$ flow parses to end of input and would reach
  // KaTeX half-written. Unclosed fences/indented code are well-defined partial blocks, and
  // react-markdown renders raw HTML as literal text, so html/fence/indented tails parse fine.
  // tailMathStart lets the caller hide the open formula and still render the safe text before it.
  return { blocks, tail: current, tailMathStart: math ? mathStart : -1 };
}
