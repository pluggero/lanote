import * as Y from 'yjs';

/**
 * Deterministic JSON serialization with object keys sorted recursively.
 * Used as a content fingerprint so two logically-identical objects with
 * different key order don't look changed to synthesizeEntry below.
 */
export function stableStringify(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/**
 * A node or edge's merge-relevant state in the room-state Y.Map: last-known
 * value (null means deleted, see reconcileCanvasEntries), content
 * fingerprint, and a version synthesized from content-vs-baseline
 * comparison since JSON Canvas has no native version field. Its own `id`
 * field satisfies reconcileYElements's `Array<{id: string}>` constraint.
 */
export interface CanvasVersionedEntry<T> {
  id: string;
  value: T | null;
  fingerprint: string;
  version: number;
}

/**
 * Derives a versioned entry for one candidate value relative to `baseline`
 * (the Y.Map's current entry, or undefined if never seen). Version stays
 * unchanged if the fingerprint matches the baseline's, else bumps by one --
 * "changed since baseline: yes/no" is the best granularity achievable
 * without a native version field. Edit, delete (candidateValue: null), and
 * undelete are all just "fingerprint differs from baseline's".
 */
export function synthesizeEntry<T>(
  id: string,
  baseline: CanvasVersionedEntry<T> | undefined,
  candidateValue: T | null
): CanvasVersionedEntry<T> {
  // stableStringify(null) ("null") doubles as the tombstone fingerprint --
  // real node/edge fingerprints always start with '{', so it can't collide.
  const baselineVersion = baseline?.version ?? 0;
  const baselineFingerprint = baseline?.fingerprint ?? stableStringify(null);
  const fingerprint = stableStringify(candidateValue);
  const version = fingerprint === baselineFingerprint ? baselineVersion : baselineVersion + 1;
  return { id, value: candidateValue, fingerprint, version };
}

/**
 * Picks the winner between two versioned entries for the same id: higher
 * version wins; on a tie (genuine concurrent edit/delete), lexicographic
 * fingerprint comparison breaks it deterministically, since every peer
 * computes the same two fingerprints. Plays the role Excalidraw's
 * `isNewerElement` fills with a stored `versionNonce` -- JSON Canvas has no
 * such field, so the tiebreak is derived from content instead.
 */
export function isNewerEntry<T>(candidate: CanvasVersionedEntry<T>, existing: CanvasVersionedEntry<T>): boolean {
  if (candidate.version !== existing.version) return candidate.version > existing.version;
  if (candidate.fingerprint === existing.fingerprint) return false;
  return candidate.fingerprint > existing.fingerprint;
}

/**
 * Merges one side's candidate array (e.g. local's nodes) against the
 * room-state Y.Map baseline for that element kind. Returns the full merged
 * entry list including tombstones, ready for reconcileYElements
 * (src/lib/reconcile.ts), which needs every known id present so it doesn't
 * delete a tombstone's own bookkeeping entry.
 *
 * JSON Canvas has no in-band delete marker -- removal from the array is the
 * only way a delete is expressed -- so "id in the Y.Map baseline but absent
 * from `candidates`" is ambiguous: a real delete, or this device merely
 * behind on an id another peer added. `knownIds` (idBaseline.ts) resolves
 * it: absence only counts as a delete if `knownIds` had the id before;
 * otherwise the baseline passes through unchanged, so a behind device can't
 * delete another peer's addition.
 */
export function reconcileCanvasEntries<T extends { id: string }>(
  yMap: Y.Map<CanvasVersionedEntry<T>>,
  candidates: T[],
  knownIds: Set<string>
): CanvasVersionedEntry<T>[] {
  const candidateById = new Map(candidates.map(c => [c.id, c]));
  const allIds = new Set<string>([...yMap.keys(), ...candidateById.keys()]);

  const result: CanvasVersionedEntry<T>[] = [];
  for (const id of allIds) {
    const baseline = yMap.get(id);
    if (!candidateById.has(id) && baseline !== undefined && !knownIds.has(id)) {
      result.push(baseline);
      continue;
    }
    const candidateValue = candidateById.get(id) ?? null;
    const candidateEntry = synthesizeEntry(id, baseline, candidateValue);
    const existingEntry = baseline ?? synthesizeEntry<T>(id, undefined, null);
    result.push(isNewerEntry(candidateEntry, existingEntry) ? candidateEntry : existingEntry);
  }
  return result;
}
