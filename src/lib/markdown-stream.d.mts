export function normalizeDisplayMath(text: string): string;

export function splitStreamingMarkdown(text: string): {
  blocks: string[];
  tail: string;
  /** An open $$ flow reached end of input; the caller must render this tail as plain text. */
  tailPlain: boolean;
};
