import { detectFileType } from './detectFileType';

const TYPES_NEEDING_BASELINE = new Set(['excalidraw', 'canvas']);

/**
 * Whether wireRelPath needs sync/syncBaseline.ts's fast-forward-vs-conflict
 * check before configSync.ts treats a local/remote mismatch as a conflict.
 * Applies to file types with no *board/scene-wide* live channel, so a peer
 * that's merely behind can't be told apart from one that diverged without a
 * remembered baseline. Canvas's per-card live session (canvasCardSession.ts)
 * only keeps one focused card's text fresh, not the rest of the board, so
 * it doesn't remove the need for this check.
 */
export function needsSyncBaseline(wireRelPath: string): boolean {
  const type = detectFileType(wireRelPath);
  return type !== null && TYPES_NEEDING_BASELINE.has(type);
}
