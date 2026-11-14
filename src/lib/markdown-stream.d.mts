export function normalizeDisplayMath(text: string): string;

export function splitStreamingMarkdown(text: string): {
  blocks: string[];
  tail: string;
  /** Offset of an open $$ opener within the tail, -1 when none; the caller hides that region. */
  tailMathStart: number;
};
