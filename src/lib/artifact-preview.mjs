const MAX_INPUT_LENGTH = 1024 * 1024;
const MAX_COLUMNS = 100;
const MAX_ROWS = 500;

const PREVIEW_KINDS = new Map([
  ['html', 'html'], ['htm', 'html'],
  ['md', 'markdown'], ['markdown', 'markdown'],
  ['csv', 'table'], ['tsv', 'table'],
]);
const CODE_LANGUAGES = new Map([
  ['js', 'javascript'], ['mjs', 'javascript'], ['jsx', 'javascript'],
  ['ts', 'typescript'], ['tsx', 'typescript'], ['py', 'python'],
  ['rs', 'rust'], ['go', 'go'], ['java', 'java'],
  ['c', 'cpp'], ['cpp', 'cpp'], ['h', 'cpp'],
  ['json', 'json'], ['css', 'css'], ['xml', 'xml'], ['sql', 'sql'],
  ['yml', 'yaml'], ['yaml', 'yaml'], ['ini', 'ini'], ['toml', 'ini'], ['tex', 'latex'],
]);

function extension(name) {
  // A dot in a directory is not a filename extension; both path separator styles are harmless here.
  const dot = name.lastIndexOf('.');
  return dot > Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) ? name.slice(dot + 1).toLowerCase() : '';
}

export function artifactPreviewKind(name) {
  return PREVIEW_KINDS.get(extension(name)) ?? 'code';
}

export function artifactCodeLanguage(name) {
  return CODE_LANGUAGES.get(extension(name)) ?? null;
}

export function parseDelimitedPreview(text, delimiter = ',') {
  if (typeof text !== 'string') throw new TypeError('Preview text must be a string.');
  if (delimiter !== ',' && delimiter !== '\t') throw new TypeError('Delimiter must be comma or tab.');
  // The backend limits files to 1 MiB of UTF-8. Bound direct callers too, without a DOM or byte encoder.
  if (text.length > MAX_INPUT_LENGTH) throw new RangeError('Preview text exceeds 1 MiB of characters.');

  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let headers = null;
  const rows = [];
  let width = 0;
  let truncated = false;

  while (pos < text.length) {
    // Ignore physical blank records, not quoted empty cells, delimiter-only records or literal spaces.
    if (text[pos] === '\r' || text[pos] === '\n') {
      if (text[pos++] === '\r' && text[pos] === '\n') pos++;
      continue;
    }

    // Validate one lookahead record, but never allocate its cells or any discarded columns.
    const row = headers === null || rows.length < MAX_ROWS ? [] : null;
    let columns = 0;
    for (;;) {
      let start = pos;
      let end;
      let quoted = false;
      if (text[pos] === '"') {
        quoted = true;
        start = ++pos;
        let closed = false;
        while (pos < text.length) {
          if (text[pos] !== '"') {
            pos++;
          } else if (text[pos + 1] === '"') {
            pos += 2;
          } else {
            end = pos++;
            closed = true;
            break;
          }
        }
        if (!closed) throw new SyntaxError('Unclosed quoted field.');
        const next = text[pos];
        if (next !== undefined && next !== delimiter && next !== '\r' && next !== '\n') {
          throw new SyntaxError('Unexpected text after closing quote.');
        }
      } else {
        while (pos < text.length && text[pos] !== delimiter && text[pos] !== '\r' && text[pos] !== '\n') {
          if (text[pos] === '"') throw new SyntaxError('Unexpected quote in unquoted field.');
          pos++;
        }
        end = pos;
      }

      columns = Math.min(columns + 1, MAX_COLUMNS + 1);
      if (columns > MAX_COLUMNS) truncated = true;
      if (row && columns <= MAX_COLUMNS) {
        // Slice once per retained cell: escaped quotes must not create a per-character parts array.
        const value = text.slice(start, end);
        row.push(quoted ? value.replace(/""/g, '"') : value);
      }
      if (text[pos] === delimiter) {
        pos++;
        continue;
      }
      if (text[pos] === '\r' || text[pos] === '\n') {
        if (text[pos++] === '\r' && text[pos] === '\n') pos++;
      }
      break;
    }

    width = Math.max(width, Math.min(columns, MAX_COLUMNS));
    if (headers === null) {
      headers = row;
    } else if (row) {
      rows.push(row);
    } else {
      // Anything after this complete extra data record is outside the preview, including malformed text.
      truncated = true;
      break;
    }
  }

  headers ??= [];
  while (headers.length < width) headers.push('');
  for (const row of rows) while (row.length < width) row.push('');
  return { headers, rows, truncated };
}
