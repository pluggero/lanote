/** Per-room wire paths that sync must skip. Ref-counted so independent holders can't release each other's hold. */
const pendingByRoom = new Map<string, Map<string, number>>();

export function addPendingExclusion(roomId: string, paths: Iterable<string>): void {
  let counts = pendingByRoom.get(roomId);
  if (!counts) {
    counts = new Map();
    pendingByRoom.set(roomId, counts);
  }
  for (const path of paths) counts.set(path, (counts.get(path) ?? 0) + 1);
}

export function removePendingExclusion(roomId: string, paths: Iterable<string>): void {
  const counts = pendingByRoom.get(roomId);
  if (!counts) return;
  for (const path of paths) {
    const next = (counts.get(path) ?? 0) - 1;
    if (next > 0) counts.set(path, next);
    else counts.delete(path);
  }
  if (counts.size === 0) pendingByRoom.delete(roomId);
}

/** Excludes `paths` while `fn` runs; always releases them. */
export async function withPendingExclusion<T>(roomId: string, paths: readonly string[], fn: () => Promise<T>): Promise<T> {
  addPendingExclusion(roomId, paths);
  try {
    return await fn();
  } finally {
    removePendingExclusion(roomId, paths);
  }
}

export function getPendingExclusions(roomId: string): Set<string> {
  return new Set(pendingByRoom.get(roomId)?.keys());
}
