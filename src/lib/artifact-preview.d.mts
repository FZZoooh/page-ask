export type ArtifactPreviewKind = 'html' | 'markdown' | 'table' | 'code';
export type ArtifactCodeLanguage =
  | 'javascript' | 'typescript' | 'python' | 'rust' | 'go' | 'java' | 'cpp'
  | 'json' | 'css' | 'xml' | 'sql' | 'yaml' | 'ini' | 'latex';

export function artifactPreviewKind(name: string): ArtifactPreviewKind;
export function artifactCodeLanguage(name: string): ArtifactCodeLanguage | null;
export function parseDelimitedPreview(text: string, delimiter?: ',' | '\t'): {
  headers: string[];
  rows: string[][];
  truncated: boolean;
};
