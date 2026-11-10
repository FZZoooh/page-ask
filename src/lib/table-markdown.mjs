/**
 * Markdown tables cannot express merged cells, and Defuddle falls back to raw
 * HTML for any table with colspan/rowspan. Expand such tables into a plain
 * rectangular grid before extraction so Defuddle's table rule emits GFM.
 *
 * Spanned cells repeat their content: a rowspan group label such as "2024"
 * stays readable on every row, which is more useful to the model than blanks.
 */
export function normalizeTableSpans(doc) {
  for (const table of doc.querySelectorAll('table')) {
    // ArXiv/Wikipedia wrap equations in tables; Defuddle has a dedicated
    // equation path that must see the original structure.
    if (table.closest('.ltx_equation, .ltx_eqn_table, .numblk')) continue;
    // Nested tables are layout scaffolding; Defuddle flattens their cells and
    // converts each nested data table separately.
    if (table.querySelector('table')) continue;

    const rows = Array.from(table.rows ?? []).length
      ? Array.from(table.rows)
      : Array.from(table.querySelectorAll('tr')).filter((tr) => tr.closest('table') === table);
    if (rows.length === 0) continue;

    const spanOf = (cell, name, prop) => {
      const value = Number(cell[prop] ?? cell.getAttribute(name) ?? 1);
      return Number.isFinite(value) && value > 1 ? Math.floor(value) : 1;
    };
    const hasSpan = rows.some((row) =>
      Array.from(row.cells ?? row.querySelectorAll('td, th')).some(
        (cell) => spanOf(cell, 'colspan', 'colSpan') > 1 || spanOf(cell, 'rowspan', 'rowSpan') > 1,
      ),
    );
    if (!hasSpan) continue;

    const grid = [];
    for (let r = 0; r < rows.length; r++) {
      grid[r] ??= [];
      let c = 0;
      const cells = Array.from(rows[r].cells ?? rows[r].querySelectorAll('td, th'));
      for (const cell of cells) {
        while (grid[r][c] !== undefined) c++;
        const rowSpan = Math.min(spanOf(cell, 'rowspan', 'rowSpan'), rows.length - r);
        const colSpan = Math.min(spanOf(cell, 'colspan', 'colSpan'), 32);
        const html = cell.innerHTML;
        for (let dr = 0; dr < rowSpan; dr++) {
          grid[r + dr] ??= [];
          for (let dc = 0; dc < colSpan; dc++) {
            // A horizontal merge cannot be expressed in GFM: leave the extra
            // columns blank. A vertical merge is repeated so each row reads
            // on its own ("2024" beside every value).
            grid[r + dr][c + dc] = dc === 0 ? html : '';
          }
        }
        c += colSpan;
      }
    }

    const width = Math.max(...grid.map((row) => row.length));
    const headerRow = rows[0];
    const headerCells = headerRow.cells
      ? Array.from(headerRow.cells)
      : Array.from(headerRow.querySelectorAll('th, td'));
    const hasHeader = headerCells.some((cell) => cell.tagName === 'TH');
    const caption = Array.from(table.children).find((child) => child.tagName === 'CAPTION') ?? null;
    const tbody = doc.createElement('tbody');
    for (let r = 0; r < grid.length; r++) {
      const tr = doc.createElement('tr');
      for (let c = 0; c < width; c++) {
        // Keep the first row's header semantics even though the rebuilt table
        // has no thead; Defuddle uses the first row as the GFM header either way.
        const cell = doc.createElement(r === 0 && hasHeader ? 'th' : 'td');
        cell.innerHTML = grid[r][c] ?? '';
        tr.appendChild(cell);
      }
      tbody.appendChild(tr);
    }
    table.replaceChildren(...(caption ? [caption] : []), tbody);
  }
}
