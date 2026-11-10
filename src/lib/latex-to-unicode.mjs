import katex from 'katex';

/**
 * Best-effort LaTeX → Unicode for quote chips. KaTeX already knows the symbols, so render MathML and
 * walk it instead of maintaining a second LaTeX parser; fractions become `a/b`, scripts stay readable.
 */

const SUPERSCRIPT = {
  '0': '⁰',
  '1': '¹',
  '2': '²',
  '3': '³',
  '4': '⁴',
  '5': '⁵',
  '6': '⁶',
  '7': '⁷',
  '8': '⁸',
  '9': '⁹',
  '+': '⁺',
  '-': '⁻',
  '−': '⁻',
  '=': '⁼',
  '(': '⁽',
  ')': '⁾',
  n: 'ⁿ',
  i: 'ⁱ',
  '′': '′',
  '″': '″',
};

const SUBSCRIPT = {
  '0': '₀',
  '1': '₁',
  '2': '₂',
  '3': '₃',
  '4': '₄',
  '5': '₅',
  '6': '₆',
  '7': '₇',
  '8': '₈',
  '9': '₉',
  '+': '₊',
  '-': '₋',
  '−': '₋',
  '=': '₌',
  '(': '₍',
  ')': '₎',
  a: 'ₐ',
  e: 'ₑ',
  h: 'ₕ',
  i: 'ᵢ',
  j: 'ⱼ',
  k: 'ₖ',
  l: 'ₗ',
  m: 'ₘ',
  n: 'ₙ',
  o: 'ₒ',
  p: 'ₚ',
  r: 'ᵣ',
  s: 'ₛ',
  t: 'ₜ',
  u: 'ᵤ',
  v: 'ᵥ',
  x: 'ₓ',
};

const BINARY = new Set(['=', '+', '−', '-', '±', '∓', '⋅', '×', '÷', '<', '>', '≤', '≥', '≠', '≈', '≡', '→', '⇒', '∈', '∪', '∩']);
const INVISIBLE = /[\u2061\u2062\u2063\u2064]/g;
/** Bubble renders call this for every visible quote on each streaming flush; cache by source. */
const CACHE_LIMIT = 200;
const cache = new Map();

function children(node) {
  return Array.from(node.childNodes ?? []).filter((child) => child.nodeType === 1);
}

function text(node) {
  return (node.textContent ?? '').replace(INVISIBLE, '');
}

/** Atomic values need no parentheses around a fraction part */
function atomic(value) {
  return value.length > 0 && !/[\s+\-−=<>/,]/.test(value) && !value.includes('(');
}

function wrap(value) {
  return atomic(value) ? value : `(${value})`;
}

function scripts(base, script, map, marker) {
  const compact = script.replace(/\s+/g, '');
  const chars = [...compact];
  if (chars.length > 0 && chars.every((ch) => map[ch])) return base + chars.map((ch) => map[ch]).join('');
  return `${base}${marker}${wrap(compact)}`;
}

function elementText(node) {
  const name = (node.localName ?? '').toLowerCase();
  const kids = children(node);

  switch (name) {
    case 'annotation':
    case 'none':
    case 'mprescripts':
      return '';
    case 'semantics': {
      // <semantics><mrow>…</mrow><annotation>source</annotation></semantics>
      const body = kids.find((child) => (child.localName ?? '').toLowerCase() !== 'annotation');
      return body ? elementText(body) : '';
    }
    case 'math':
    case 'mrow':
    case 'mstyle':
    case 'mpadded':
    case 'mphantom':
    case 'merror':
    case 'menclose':
      return kids.map(elementText).join('');
    case 'mi':
    case 'mn':
    case 'mtext':
      return text(node);
    case 'mo': {
      const value = text(node).trim();
      if (!value) return '';
      if (BINARY.has(value)) return ` ${value} `;
      if (value === ',') return ', ';
      return value;
    }
    case 'mspace':
      return ' ';
    case 'mfrac': {
      const [num, den] = kids;
      const n = num ? elementText(num) : '';
      const d = den ? elementText(den) : '';
      return `${wrap(n.trim())}/${wrap(d.trim())}`;
    }
    case 'msup': {
      const [base, sup] = kids;
      return scripts(base ? elementText(base).trim() : '', sup ? elementText(sup).trim() : '', SUPERSCRIPT, '^');
    }
    case 'msub': {
      const [base, sub] = kids;
      return scripts(base ? elementText(base).trim() : '', sub ? elementText(sub).trim() : '', SUBSCRIPT, '_');
    }
    case 'msubsup': {
      const [base, sub, sup] = kids;
      const b = base ? elementText(base).trim() : '';
      const under = sub ? elementText(sub).trim() : '';
      const over = sup ? elementText(sup).trim() : '';
      return `${scripts(b, under, SUBSCRIPT, '_')}${scripts('', over, SUPERSCRIPT, '^')}`;
    }
    case 'msqrt':
      return `√(${kids.map(elementText).join('')})`;
    case 'mroot': {
      const [base, index] = kids;
      return `${wrap(index ? elementText(index).trim() : '')}√(${base ? elementText(base) : ''})`;
    }
    case 'mover':
    case 'munder':
    case 'munderover': {
      const [base, under, over] = kids;
      const b = base ? elementText(base).trim() : '';
      if (name === 'munderover') {
        return `${scripts(b, under ? elementText(under).trim() : '', SUBSCRIPT, '_')}${scripts('', over ? elementText(over).trim() : '', SUPERSCRIPT, '^')}`;
      }
      const accent = (under ? elementText(under) : over ? elementText(over) : '').trim();
      if (!accent) return b;
      return `${b}${accent.length <= 2 ? accent : `^(${accent})`}`;
    }
    case 'mtable':
      return kids.map((row) => children(row).map((cell) => elementText(cell).trim()).join(' | ')).join('; ');
    case 'mtr':
    case 'mtd':
      return kids.map(elementText).join('');
    default:
      return kids.map(elementText).join('');
  }
}

/** Convert a KaTeX MathML subtree to plain Unicode text (exported for tests) */
export function mathmlToUnicode(root) {
  return elementText(root)
    .replace(INVISIBLE, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([,;])\s*/g, '$1 ')
    .replace(/\s*\/\s*/g, '/')
    .trim();
}

/** Render LaTeX and flatten it to Unicode; falls back to the source when KaTeX cannot parse it */
export function latexToUnicode(latex) {
  const source = latex.trim();
  if (!source) return '';
  const cached = cache.get(source);
  if (cached !== undefined) return cached;
  let value = source;
  try {
    const html = katex.renderToString(source, {
      throwOnError: false,
      strict: false,
      output: 'mathml',
      displayMode: false,
    });
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const math = doc.querySelector('math');
    value = math ? mathmlToUnicode(math) || source : source;
  } catch {
    value = source;
  }
  cache.set(source, value);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return value;
}
