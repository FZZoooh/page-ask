/** contenteditable 的纯 DOM 操作：不碰 React state，方便单测与复用 */

/** 把 contenteditable 的内容序列化成消息文本：引用 chip → <q>…</q>，其余按字面 */
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
      out.s += `<q>${q}</q>`;
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
 * 在光标处插入纯文本（\n → <br>）；没有文档选区时用 fallback（编辑器内最后一次光标）。
 * 换行不再走这里：Shift+Enter 交给浏览器原生 insertLineBreak，避免行尾占位问题。
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

/** 把恢复出来的提问填回输入框；消息里序列化的 <q>…</q> 还原成引用 chip */
export function fillEditor(el: HTMLElement, text: string): void {
  el.innerHTML = '';
  for (const part of text.split(/(<q>[\s\S]*?<\/q>)/g)) {
    if (!part) continue;
    const m = /^<q>([\s\S]*)<\/q>$/.exec(part);
    if (!m) {
      el.appendChild(document.createTextNode(part));
      continue;
    }
    const quote = m[1] ?? '';
    const chip = document.createElement('span');
    chip.className = 'q-chip';
    chip.contentEditable = 'false';
    chip.dataset.quote = quote;
    chip.title = quote;
    chip.textContent = quote;
    el.appendChild(chip);
  }
}

/** 输入框里已经有用户草稿时不要用恢复内容覆盖它 */
export function editorHasDraft(el: HTMLElement | null): boolean {
  return Boolean(el?.textContent?.trim());
}
