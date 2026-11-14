export function artifactName(line: string): string | null;

/** A remark plugin; Markdown supplies the processor, parsed tree and source file. */
export function remarkArtifactTags(this: { parse(source: string): unknown }): (tree: unknown, file: unknown) => void;

export function splitArtifactMarkdown(text: string): {
  blocks: string[];
  tail: string;
  /** An open $$ flow reached end of input; the caller must render this tail as plain text. */
  tailPlain: boolean;
};
