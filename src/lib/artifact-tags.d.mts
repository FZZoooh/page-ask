export function artifactName(line: string): string | null;

/** A remark plugin; Markdown supplies the processor, parsed tree and source file. */
export function remarkArtifactTags(this: { parse(source: string): unknown }): (tree: unknown, file: unknown) => void;

export function splitArtifactMarkdown(text: string): {
  blocks: string[];
  tail: string;
  /** Offset of an open $$ opener within the tail, -1 when none; the caller hides that region. */
  tailMathStart: number;
};
