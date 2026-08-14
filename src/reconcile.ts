import * as Y from 'yjs';

/**
 * Reconciles the content of a Y.Text CRDT with a target plain text string.
 * Uses a highly efficient common-prefix/common-suffix matching algorithm
 * to apply minimal edits (delete + insert), thereby preserving remote cursor
 * position indicators and maximizing performance.
 */
export function reconcileYText(ytext: Y.Text, newText: string): void {
  const oldText = ytext.toString();
  if (oldText === newText) return;

  // Find common prefix
  let start = 0;
  while (
    start < oldText.length &&
    start < newText.length &&
    oldText.charAt(start) === newText.charAt(start)
  ) {
    start++;
  }

  // Find common suffix
  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (
    oldEnd > start &&
    newEnd > start &&
    oldText.charAt(oldEnd - 1) === newText.charAt(newEnd - 1)
  ) {
    oldEnd--;
    newEnd--;
  }

  // Apply the updates atomically inside a transaction
  ytext.doc?.transact(() => {
    if (oldEnd > start) {
      ytext.delete(start, oldEnd - start);
    }
    if (newEnd > start) {
      ytext.insert(start, newText.substring(start, newEnd));
    }
  });
}

/**
 * Reconciles the entries of a Y.Map with a target array of already-merged
 * items, each identified by its own `id` field (e.g. Excalidraw scene
 * elements). Only `.set()`s entries whose serialized value actually
 * changed, and removes entries absent from `merged`, inside one
 * transaction -- the Y.Text equivalent of reconcileYText's minimal-diff
 * approach, but for keyed CRDT maps instead of ordered text.
 */
export function reconcileYElements(yElements: Y.Map<any>, merged: Array<{ id: string }>): void {
  const mergedById = new Map(merged.map(item => [item.id, item]));

  yElements.doc?.transact(() => {
    for (const [id, item] of mergedById) {
      const current = yElements.get(id);
      if (current === undefined || JSON.stringify(current) !== JSON.stringify(item)) {
        yElements.set(id, item);
      }
    }
    for (const id of yElements.keys()) {
      if (!mergedById.has(id)) yElements.delete(id);
    }
  });
}
