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
