/** Pure DOM helpers for contenteditable: no React state, so they stay testable and reusable */

import { latexToUnicode } from '@/lib/latex-to-unicode.mjs';

/** Escape quote text so a pasted `</pageask-quote>` cannot terminate the serialized quote early */
export function encodeQuote(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Inverse of encodeQuote; decode &amp; last so "&amp;lt;" round-trips literally */
export function decodeQuote(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/**
 * Serialize contenteditable content to message text: quote chips become <pageask-quote>…</pageask-quote>
 * (artifact references <pageask-file>…</pageask-file>), everything else stays literal. Both tag names
 * are deliberately outside the HTML spec — see fillEditor. Storage keeps the tags; only the backend
 * converts them to Markdown blockquotes when building the upstream request.
 */
export function serializeEditor(el: HTMLElement | null): string {
  if (!el) return '';
  const out = { s: '' };
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out.s += (node.nodeValue ?? '').replace(/\u200b/g, '');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const e = node as HTMLElement;
    const q = e.dataset?.quote;
    if (q != null) {
      out.s += e.dataset?.quoteFile != null
        ? `<pageask-file>${encodeQuote(q)}</pageask-file>`
        : `<pageask-quote>${encodeQuote(q)}</pageask-quote>`;
      return;
    }
    if (e.tagName === 'BR') {
      out.s += '\n';
      return;
    }
    e.childNodes.forEach(walk);
  };
  el.childNodes.forEach(walk);
  return out.s.replace(/\n{3,}$/, '\n');
}

/**
 * Insert plain text at the caret; no document selection → fallback (last editor caret). The insert
 * must go through execCommand (insertText per line, insertLineBreak between them): direct DOM
 * mutations like Range.insertNode never enter Chromium's contenteditable undo stack, so Ctrl+Z
 * could not remove a paste. One insertText for the whole text is not an option either — it builds
 * <div> blocks, which serializeEditor cannot turn back into newlines — while insertLineBreak keeps
 * the exact structure Shift+Enter already produces. Re-setting the selection looks redundant but
 * closes the open typing transaction, so the paste becomes its own undo entry instead of merging
 * with the text typed just before it.
 */
export function insertTextAtCaret(el: HTMLElement, text: string, fallback: Range | null): void {
  el.focus();
  const sel = window.getSelection();
  let range: Range | null = null;
  if (sel && sel.rangeCount > 0) {
    const cur = sel.getRangeAt(0);
    if (el.contains(cur.commonAncestorContainer)) range = cur;
  }
  if (!range && fallback && el.contains(fallback.startContainer)) range = fallback.cloneRange();
  if (!range) {
    range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
  }
  sel?.removeAllRanges();
  sel?.addRange(range);
  text.replace(/\r\n?/g, '\n').split('\n').forEach((line, i) => {
    if (i > 0) document.execCommand('insertLineBreak');
    if (line) document.execCommand('insertText', false, line);
  });
}

/**
 * A formula quote carries its LaTeX between `$…$` / `$$…$$` delimiters. The chip shows Unicode, but
 * data-quote (and therefore the message sent upstream) keeps the original source.
 */
export function quoteMathText(text: string): string | null {
  const m = /^\s*(\$\$|\$)([\s\S]*?)\1\s*$/.exec(text);
  if (!m) return null;
  const raw = m[2] ?? '';
  // `$5 and $6` is money, not math: real formulas never pad the inside with spaces/tabs. Newlines
  // are allowed because a multi-line display formula legitimately starts or ends with one.
  if (!raw.trim()) return null;
  if (/^[ \t]|[ \t]$/.test(raw)) return null;
  try {
    return latexToUnicode(raw) || null;
  } catch {
    return null;
  }
}

/** Only the first line of a quote is shown; the full text stays in data-quote for sending */
export function quoteChipLabel(text: string): string {
  const math = quoteMathText(text);
  if (math) return math;
  const nl = text.search(/[\r\n]/);
  if (nl < 0) return text;
  const head = text.slice(0, nl).replace(/[ \t]+$/, '');
  const rest = text.slice(nl).replace(/^[\r\n]+/, '').trim();
  return rest ? `${head}…` : head;
}

/** Build the non-editable quote chip shared by insertion and recovery; CSS caps its width.
 *  file=true marks an artifact reference, stored as <pageask-file> instead of <pageask-quote>. */
export function createQuoteChip(text: string, file = false): HTMLElement {
  const chip = document.createElement('span');
  chip.className = 'q-chip';
  chip.contentEditable = 'false';
  chip.dataset.quote = text;
  if (file) chip.dataset.quoteFile = '1';
  chip.title = text;
  const label = document.createElement('span');
  label.className = 'q-chip-label';
  label.textContent = quoteChipLabel(text);
  chip.appendChild(label);
  return chip;
}

/**
 * Put a recovered question back into the editor; stored chips become quote chips again.
 * Both chip tags carry the pageask prefix deliberately: a user discussing HTML can type a real
 * tag like <q> literally and it stays plain text — nothing parses it as a chip any more.
 */
export function fillEditor(el: HTMLElement, text: string): void {
  el.innerHTML = '';
  for (const part of text.split(/(<pageask-quote>[\s\S]*?<\/pageask-quote>|<pageask-file>[\s\S]*?<\/pageask-file>)/g)) {
    if (!part) continue;
    const m = /^<(pageask-quote|pageask-file)>([\s\S]*)<\/\1>$/.exec(part);
    if (!m) {
      el.appendChild(document.createTextNode(part));
      continue;
    }
    el.appendChild(createQuoteChip(decodeQuote(m[2] ?? ''), m[1] === 'pageask-file'));
  }
  syncEditorEmptyState(el);
}

/** True when the editor has no real text (a lone <br>/block wrapper is caret padding, not content) */
export function editorIsEmpty(el: HTMLElement | null): boolean {
  return Boolean(el) && (el?.textContent ?? '').replace(/\u200b/g, '').length === 0;
}

/**
 * Mirror emptiness onto a data attribute. `:empty` cannot see a lone <br> left by Chromium (or an
 * IME composition that ended without a final input event), so the CSS placeholder also keys off this.
 */
export function syncEditorEmptyState(el: HTMLElement | null): void {
  if (!el) return;
  el.toggleAttribute('data-empty', editorIsEmpty(el));
}

/**
 * Chromium keeps a placeholder line after the last character is deleted (a lone `<br>`, or
 * `<div><br></div>` when Enter produced blocks), so `.editor:empty` stops matching and the CSS
 * placeholder never comes back. Drop that residue once no text is left and restore the caret.
 * Returns whether the editor was cleaned.
 */
export function clearEmptyEditorResidue(el: HTMLElement | null): boolean {
  if (!el || !el.firstChild) return false;
  // Test textContent, not a trimmed serialization: a space the user typed is content, while
  // <br>/block wrappers contribute no text and zero-width padding is invisible anyway.
  if (!editorIsEmpty(el)) {
    syncEditorEmptyState(el);
    return false;
  }
  const sel = window.getSelection();
  const caretInside = Boolean(sel && sel.rangeCount > 0 && el.contains(sel.getRangeAt(0).commonAncestorContainer));
  el.innerHTML = '';
  syncEditorEmptyState(el);
  if (caretInside && sel) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  return true;
}

/** A recovery must not overwrite a draft the user already typed into the editor */
export function editorHasDraft(el: HTMLElement | null): boolean {
  return Boolean(el?.textContent?.trim());
}
