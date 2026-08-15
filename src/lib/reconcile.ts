import * as Y from 'yjs';

/**
 * Reconciles a Y.Text CRDT with a target plain text string via minimal
 * common-prefix/suffix delete+insert, preserving remote cursor positions.
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
 * Reconciles a Y.Map with a target array of already-merged items keyed by
 * `id`: `.set()`s only entries whose value actually changed, removes
 * entries absent from `merged`, all in one transaction.
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
