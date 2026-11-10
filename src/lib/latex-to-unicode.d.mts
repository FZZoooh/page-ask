/** Convert KaTeX MathML markup to plain Unicode text */
export function mathmlToUnicode(root: Element): string;
/** Render a LaTeX formula and flatten it to Unicode; returns the source when parsing fails */
export function latexToUnicode(latex: string): string;
