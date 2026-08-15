import type { ExcalidrawElementLike } from './codec';

function isNewerElement(candidate: ExcalidrawElementLike, existing: ExcalidrawElementLike): boolean {
  if (candidate.version !== existing.version) return candidate.version > existing.version;
  return candidate.versionNonce > existing.versionNonce;
}

/**
 * Merges two element arrays from the same drawing into one, keeping
 * exactly one entry per element id. Mirrors Excalidraw's own official
 * real-time-collaboration reconciliation: the element with the higher
 * `version` wins; if both sides independently reached the same version
 * number, `versionNonce` (a random per-edit tiebreaker) decides, so every
 * peer computes the identical winner from the identical two candidates. A
 * deleted element (`isDeleted: true`) is kept in the result rather than
 * dropped -- there's no special-casing of `isDeleted` here at all, so a
 * delete on one peer can't be silently resurrected by a concurrent edit to
 * the same element elsewhere.
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
 * Rewrites the text portion of each `## Text Elements` line in
 * `shellPrefix` to match the corresponding element's `.text` in `merged`.
 *
 * The Excalidraw plugin parses these `<text> ^<elementId>` lines on file
 * load and overwrites the matching element's `.text`/`.originalText` with
 * them (see the doc comment on ExcalidrawFileParts.shellPrefix in
 * codec.ts). `resolveExcalidrawConflict` picks `shellPrefix` -- and this
 * section along with it -- from whichever side has the newer mtime,
 * independent of which side's element won reconcileElementArrays above.
 * Without this function, that section can keep the pre-merge text of the
 * losing side, and the plugin then writes that text back over the correct
 * merge the next time any peer opens the file.
 *
 * Only replaces the text of a line whose id is already present in
 * `merged`; never adds, removes, or reorders lines. Leaves a line
 * untouched if its merged element's `.text` contains `\n`, since this
 * line-based format has no way to represent it and this function doesn't
 * reformat the section, only substitutes single-line text values.
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
