// Text extraction for Office Open XML files (docx / xlsx / pptx). These are zip archives of XML parts;
// fflate unzips only the parts we read and a small tolerant XML reader walks them into Markdown-ish text
// (headings, lists, tables, slides), which is what read_file serves to the model.
import { unzipSync } from 'fflate';

/** Single decompressed part / whole-archive caps: a hostile zip should fail, not exhaust memory */
const MAX_PART_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 192 * 1024 * 1024;
const MAX_SHEET_COLUMNS = 60;

export class OfficeError extends Error {}

const PARTS = {
  docx: /^word\/(document|styles)\.xml$/,
  xlsx: /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/,
  pptx: /^ppt\/(presentation\.xml|_rels\/presentation\.xml\.rels|slides\/slide\d+\.xml|slides\/_rels\/slide\d+\.xml\.rels|notesSlides\/notesSlide\d+\.xml)$/,
};

/** Which OOXML flavor a zip is, judged by its parts rather than the file name; null if neither. */
export function officeFormat(bytes) {
  let names = [];
  try {
    unzipSync(bytes, {
      filter: (f) => {
        names.push(f.name);
        return false;
      },
    });
  } catch {
    return null;
  }
  const has = new Set(names);
  if (has.has('word/document.xml')) return 'docx';
  if (has.has('xl/workbook.xml')) return 'xlsx';
  if (has.has('ppt/presentation.xml')) return 'pptx';
  return null;
}

/** @returns {{ text: string, pages: number | null }} pages = slide count (pptx) or sheet count (xlsx) */
export function extractOffice(bytes, format) {
  const files = unzipParts(bytes, PARTS[format]);
  if (format === 'docx') return { text: docxText(files), pages: null };
  if (format === 'xlsx') return xlsxText(files);
  return pptxText(files);
}

function unzipParts(bytes, pattern) {
  let total = 0;
  let raw;
  try {
    raw = unzipSync(bytes, {
      filter: (f) => {
        if (!pattern.test(f.name)) return false;
        total += f.originalSize;
        if (f.originalSize > MAX_PART_BYTES || total > MAX_TOTAL_BYTES) throw new OfficeError('archive too large');
        return true;
      },
    });
  } catch (err) {
    if (err instanceof OfficeError) throw err;
    throw new OfficeError(`bad archive: ${err?.message ?? err}`);
  }
  const decoder = new TextDecoder('utf-8');
  const out = {};
  for (const [name, data] of Object.entries(raw)) out[name] = decoder.decode(data);
  return out;
}

/* ---------------- minimal XML reader ---------------- */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

/** Element tree with namespace prefixes stripped from tag and attribute names. Text nodes are strings. */
function parseXml(xml) {
  const root = { name: '#root', attrs: {}, children: [] };
  const stack = [root];
  const re =
    /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)([^>]*?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) {
      top.children.push(m[1]);
    } else if (m[2] !== undefined) {
      const name = local(m[2]);
      // Tolerate stray closers: pop back to the matching element if there is one
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].name === name) {
          stack.length = i;
          break;
        }
      }
    } else if (m[3] !== undefined) {
      const node = { name: local(m[3]), attrs: parseAttrs(m[4]), children: [] };
      top.children.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6] !== undefined) {
      top.children.push(decodeEntities(m[6]));
    }
  }
  return root;
}

function parseAttrs(s) {
  const attrs = {};
  if (!s) return attrs;
  const re = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(s))) {
    const key = m[1];
    const value = decodeEntities(m[2] ?? m[3] ?? '');
    attrs[key] = value;
    // Also index by local name; `r:id` and `id` differ in rels, so the full name wins when both exist.
    const short = local(key);
    if (!(short in attrs)) attrs[short] = value;
  }
  return attrs;
}

function local(name) {
  const i = name.indexOf(':');
  return i >= 0 ? name.slice(i + 1) : name;
}

const elements = (node) => node.children.filter((c) => typeof c !== 'string');
const child = (node, name) => node?.children.find((c) => typeof c !== 'string' && c.name === name) ?? null;
const childrenNamed = (node, name) => (node ? elements(node).filter((c) => c.name === name) : []);

function descendant(node, name) {
  if (!node) return null;
  for (const c of node.children) {
    if (typeof c === 'string') continue;
    if (c.name === name) return c;
    const hit = descendant(c, name);
    if (hit) return hit;
  }
  return null;
}

/** Concatenated text of <t> runs (w:t / a:t / t) with tab and line-break elements honored */
function runText(node, skip = new Set()) {
  let out = '';
  const walk = (n) => {
    for (const c of n.children) {
      if (typeof c === 'string') continue;
      if (skip.has(c.name)) continue;
      if (c.name === 't') out += c.children.filter((x) => typeof x === 'string').join('');
      else if (c.name === 'tab') out += '\t';
      else if (c.name === 'br' || c.name === 'cr') out += '\n';
      else walk(c);
    }
  };
  walk(node);
  return out;
}

function cell(text) {
  return text.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim();
}

function markdownTable(rows) {
  const width = Math.max(0, ...rows.map((r) => r.length));
  if (!width) return '';
  const pad = (r) => Array.from({ length: width }, (_, i) => cell(r[i] ?? ''));
  const [head, ...rest] = rows.map(pad);
  return [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...rest.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

/** Resolve a relationship target against the directory of the part that owns the .rels file */
function resolveTarget(baseDir, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = `${baseDir}/${target}`.split('/');
  const out = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p && p !== '.') out.push(p);
  }
  return out.join('/');
}

function relsMap(xml, baseDir) {
  const map = new Map();
  if (!xml) return map;
  for (const rel of childrenNamed(child(parseXml(xml), 'Relationships'), 'Relationship')) {
    if (rel.attrs.Id && rel.attrs.Target) {
      map.set(rel.attrs.Id, { target: resolveTarget(baseDir, rel.attrs.Target), type: rel.attrs.Type ?? '' });
    }
  }
  return map;
}

/* ---------------- docx ---------------- */

function docxText(files) {
  const xml = files['word/document.xml'];
  if (!xml) throw new OfficeError('missing word/document.xml');
  const styles = docxStyles(files['word/styles.xml']);
  const body = descendant(parseXml(xml), 'body');
  const out = [];
  const skip = new Set(['delText', 'instrText', 'pPr', 'rPr']);

  const paragraph = (p) => {
    const text = runText(p, skip).trim();
    if (!text) return;
    const pPr = child(p, 'pPr');
    const style = styles.get(child(pPr, 'pStyle')?.attrs.val ?? '');
    const outline = child(pPr, 'outlineLvl')?.attrs.val ?? style?.outline;
    const level = style?.heading ?? (outline != null && Number(outline) < 9 ? Number(outline) + 1 : 0);
    if (level) {
      out.push(`${'#'.repeat(Math.min(level, 6))} ${text.replace(/\s*\n\s*/g, ' ')}`);
      return;
    }
    const numPr = child(pPr, 'numPr');
    if (numPr) {
      const depth = Number(child(numPr, 'ilvl')?.attrs.val ?? 0) || 0;
      out.push(`${'  '.repeat(Math.min(depth, 8))}- ${text}`);
      return;
    }
    out.push(text);
  };

  const table = (tbl) => {
    const rows = childrenNamed(tbl, 'tr').map((tr) =>
      childrenNamed(tr, 'tc').map((tc) => runText(tc, skip).replace(/\s+/g, ' ')),
    );
    const md = markdownTable(rows);
    if (md) out.push(md);
  };

  const blocks = (node) => {
    for (const c of elements(node)) {
      if (c.name === 'p') paragraph(c);
      else if (c.name === 'tbl') table(c);
      else if (c.name === 'sdt') blocks(child(c, 'sdtContent') ?? c);
      else if (c.name === 'customXml' || c.name === 'ins' || c.name === 'smartTag') blocks(c);
    }
  };
  if (body) blocks(body);
  return out.join('\n\n');
}

/** styleId → heading level. Localized Word uses ids like "1"/"2", so read the style's real name. */
function docxStyles(xml) {
  const map = new Map();
  if (!xml) return map;
  for (const s of childrenNamed(child(parseXml(xml), 'styles'), 'style')) {
    const id = s.attrs.styleId;
    if (!id) continue;
    const name = (child(s, 'name')?.attrs.val ?? '').toLowerCase();
    const outline = child(child(s, 'pPr'), 'outlineLvl')?.attrs.val;
    const m = /^heading\s*(\d)$/.exec(name);
    const heading = m ? Number(m[1]) : name === 'title' ? 1 : name === 'subtitle' ? 2 : null;
    map.set(id, { heading, outline: outline != null ? Number(outline) : null });
  }
  return map;
}

/* ---------------- xlsx ---------------- */

function xlsxText(files) {
  const wbXml = files['xl/workbook.xml'];
  if (!wbXml) throw new OfficeError('missing xl/workbook.xml');
  const rels = relsMap(files['xl/_rels/workbook.xml.rels'], 'xl');
  const shared = files['xl/sharedStrings.xml']
    ? childrenNamed(child(parseXml(files['xl/sharedStrings.xml']), 'sst'), 'si').map((si) =>
        runText(si, new Set(['rPh', 'phoneticPr'])),
      )
    : [];
  const sheets = childrenNamed(descendant(parseXml(wbXml), 'sheets'), 'sheet');
  const out = [];
  for (const sheet of sheets) {
    const target = rels.get(sheet.attrs['r:id'] ?? sheet.attrs.id)?.target;
    const xml = target ? files[target] : null;
    if (!xml) continue;
    const rows = [];
    for (const row of childrenNamed(descendant(parseXml(xml), 'sheetData'), 'row')) {
      const values = [];
      let next = 0;
      for (const c of childrenNamed(row, 'c')) {
        const col = c.attrs.r ? columnIndex(c.attrs.r) : next;
        next = col + 1;
        if (col >= MAX_SHEET_COLUMNS) continue;
        values[col] = cellValue(c, shared);
      }
      if (values.some((v) => v)) rows.push(values);
    }
    const title = `## Sheet: ${sheet.attrs.name ?? '?'}`;
    out.push(rows.length ? `${title}\n\n${markdownTable(rows)}` : `${title}\n\n(empty)`);
  }
  return { text: out.join('\n\n'), pages: sheets.length || null };
}

function columnIndex(ref) {
  let n = 0;
  for (const ch of ref) {
    const code = ch.toUpperCase().charCodeAt(0);
    if (code < 65 || code > 90) break;
    n = n * 26 + (code - 64);
  }
  return Math.max(0, n - 1);
}

function cellValue(c, shared) {
  const t = c.attrs.t;
  if (t === 'inlineStr') return runText(child(c, 'is') ?? c);
  const v = child(c, 'v');
  const raw = v ? v.children.filter((x) => typeof x === 'string').join('') : '';
  if (t === 's') return shared[Number(raw)] ?? '';
  if (t === 'b') return raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : raw;
  return raw;
}

/* ---------------- pptx ---------------- */

function pptxText(files) {
  const presXml = files['ppt/presentation.xml'];
  if (!presXml) throw new OfficeError('missing ppt/presentation.xml');
  const rels = relsMap(files['ppt/_rels/presentation.xml.rels'], 'ppt');
  const ids = childrenNamed(descendant(parseXml(presXml), 'sldIdLst'), 'sldId');
  const out = [];
  let n = 0;
  for (const sld of ids) {
    const target = rels.get(sld.attrs['r:id'] ?? sld.attrs.id)?.target;
    const xml = target ? files[target] : null;
    if (!xml) continue;
    n++;
    const lines = slideLines(parseXml(xml));
    const slideRels = relsMap(files[target.replace(/([^/]+)$/, '_rels/$1.rels')], target.replace(/\/[^/]+$/, ''));
    const notesTarget = [...slideRels.values()].find((r) => r.type.endsWith('/notesSlide'))?.target;
    const notes = notesTarget && files[notesTarget] ? slideLines(parseXml(files[notesTarget])) : [];
    const parts = [`## Slide ${n}`];
    if (lines.length) parts.push(lines.join('\n'));
    if (notes.length) parts.push(`Notes:\n${notes.join('\n')}`);
    out.push(parts.join('\n\n'));
  }
  return { text: out.join('\n\n'), pages: n || null };
}

/** Paragraphs and tables of one slide in document order; slide-number placeholders are noise */
function slideLines(root) {
  const lines = [];
  const walk = (node) => {
    for (const c of elements(node)) {
      if (c.name === 'sp') {
        const ph = descendant(child(c, 'nvSpPr'), 'ph');
        if (ph && (ph.attrs.type === 'sldNum' || ph.attrs.type === 'sldImg')) continue;
        walk(c);
      } else if (c.name === 'tbl') {
        const rows = childrenNamed(c, 'tr').map((tr) =>
          childrenNamed(tr, 'tc').map((tc) => runText(tc).replace(/\s+/g, ' ')),
        );
        const md = markdownTable(rows);
        if (md) lines.push(md);
      } else if (c.name === 'p') {
        const text = runText(c).trim();
        if (text) lines.push(text);
      } else {
        walk(c);
      }
    }
  };
  walk(root);
  return lines;
}
