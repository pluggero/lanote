import type { ExcalidrawElementLike } from './codec';

function isNewerElement(candidate: ExcalidrawElementLike, existing: ExcalidrawElementLike): boolean {
  if (candidate.version !== existing.version) return candidate.version > existing.version;
  return candidate.versionNonce > existing.versionNonce;
}

/**
 * Merges two element arrays into one entry per id, mirroring Excalidraw's
 * own collab reconciliation: higher `version` wins, `versionNonce` (random
 * per-edit tiebreaker) breaks ties. `isDeleted: true` elements aren't
 * special-cased, so a delete can't be silently resurrected by a concurrent
 * edit elsewhere.
 */
export function reconcileElementArrays(
  a: ExcalidrawElementLike[],
  b: ExcalidrawElementLike[]
): ExcalidrawElementLike[] {
  const byId = new Map<string, ExcalidrawElementLike>();
  for (const element of a) byId.set(element.id, element);
  for (const element of b) {
    const existing = byId.get(element.id);
    if (!existing || isNewerElement(element, existing)) {
      byId.set(element.id, element);
    }
  }
  return Array.from(byId.values());
}

/**
 * Unions two `files` maps (embedded image blobs, keyed by fileId). `a`
 * wins on key collision -- callers pass whichever side's shell was kept as
 * `a`, so an image only referenced by an element from the other side (`b`)
 * is still preserved rather than dropped.
 */
export function mergeFilesMaps(a: Record<string, any>, b: Record<string, any>): Record<string, any> {
  return { ...b, ...a };
}

// Matches a `## Text Elements` line, `<text> ^<elementId>`, up to the next
// section boundary (`%%` or another `##` heading) or end of string.
const TEXT_ELEMENTS_SECTION = /(## Text Elements\n)([\s\S]*?)(?=\n%%|\n## |$)/;
const TEXT_ELEMENT_LINE = /^(.*) \^([A-Za-z0-9_-]+)$/;

/**
 * Rewrites each `## Text Elements` line's text in `shellPrefix` to match
 * the corresponding element's `.text` in `merged` (see codec.ts's
 * ExcalidrawFileParts.shellPrefix doc for why this section must stay in
 * sync with the merged elements). Only substitutes existing lines' text --
 * never adds/removes/reorders -- and skips a line whose merged text
 * contains `\n`, since this line-based format can't represent that.
 */
export function patchTextElementsMirror(shellPrefix: string, merged: ExcalidrawElementLike[]): string {
  const byId = new Map(merged.map(element => [element.id, element]));
  return shellPrefix.replace(TEXT_ELEMENTS_SECTION, (_whole, header: string, body: string) => {
    const patchedBody = body
      .split('\n')
      .map(line => {
        const lineMatch = TEXT_ELEMENT_LINE.exec(line);
        if (!lineMatch) return line;
        const id = lineMatch[2] as string;
        const element = byId.get(id);
        if (!element || typeof element.text !== 'string' || element.text.includes('\n')) return line;
        return `${element.text} ^${id}`;
      })
      .join('\n');
    return header + patchedBody;
  });
}
