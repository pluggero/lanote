export type SupportedFileType = 'excalidraw' | 'markdown' | 'json';

/**
 * Classifies a wire-relative path by the file-type-specific conflict
 * resolver it needs, or null if none applies (falls back to
 * latest-mtime-wins). `*.excalidraw.md` is checked before the generic
 * `.md` suffix, since it's a more specific match on the same extension.
 */
export function detectFileType(wireRelPath: string): SupportedFileType | null {
  if (wireRelPath.toLowerCase().endsWith('.excalidraw.md')) return 'excalidraw';
  if (wireRelPath.endsWith('.md')) return 'markdown';
  if (wireRelPath.endsWith('.json')) return 'json';
  return null;
}
