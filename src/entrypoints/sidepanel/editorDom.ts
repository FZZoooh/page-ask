/** Pure DOM helpers for contenteditable: no React state, so they stay testable and reusable */

/** Escape quote text so a pasted `</q>` cannot terminate the serialized quote early */
export function encodeQuote(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Inverse of encodeQuote; decode &amp; last so "&amp;lt;" round-trips literally */
export function decodeQuote(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** Serialize contenteditable content to message text: quote chips become <q>…</q>, everything else stays literal */
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
      out.s += `<q>${encodeQuote(q)}</q>`;
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
 * Insert plain text at the caret (\n → <br>); no document selection → fallback (last editor caret).
 * Line breaks no longer pass through here: Shift+Enter uses native insertLineBreak, avoiding placeholder-at-EOL.
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
  range.deleteContents();
  const frag = document.createDocumentFragment();
  text.split('\n').forEach((line, i) => {
    if (i > 0) frag.appendChild(document.createElement('br'));
    if (line) frag.appendChild(document.createTextNode(line));
  });
  const tail = frag.lastChild;
  range.insertNode(frag);
  if (tail) {
    const after = document.createRange();
    after.setStartAfter(tail);
    after.collapse(true);
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(after);
    }
  }
}

/** Put a recovered question back into the editor; serialized <q>…</q> becomes quote chips again */
export function fillEditor(el: HTMLElement, text: string): void {
  el.innerHTML = '';
  for (const part of text.split(/(<q>[\s\S]*?<\/q>)/g)) {
    if (!part) continue;
    const m = /^<q>([\s\S]*)<\/q>$/.exec(part);
    if (!m) {
      el.appendChild(document.createTextNode(part));
      continue;
    }
    const quote = decodeQuote(m[1] ?? '');
    const chip = document.createElement('span');
    chip.className = 'q-chip';
    chip.contentEditable = 'false';
    chip.dataset.quote = quote;
    chip.title = quote;
    chip.textContent = quote;
    el.appendChild(chip);
  }
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
  if ((el.textContent ?? '').replace(/\u200b/g, '').length > 0) return false;
  const sel = window.getSelection();
  const caretInside = Boolean(sel && sel.rangeCount > 0 && el.contains(sel.getRangeAt(0).commonAncestorContainer));
  el.innerHTML = '';
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
