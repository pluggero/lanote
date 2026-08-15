import { detectFileType } from '../detectFileType';

/**
 * Whether wireRelPath needs sync/syncBaseline.ts's fast-forward-vs-conflict
 * check before configSync.ts treats a local/remote mismatch as a conflict.
 *
 * Excalidraw drawings are the one file type that needs it today: they have
 * no live-collab channel keeping peers continuously fresh -- unlike
 * markdown notes, `*.excalidraw.md` files are explicitly excluded from the
 * live Yjs session (see collabSession.ts) and sync only via the periodic
 * REST poll. Without a remembered baseline, a peer that's merely behind
 * (made zero edits, remote moved on) is indistinguishable from one that
 * genuinely diverged, and gets fed into element-level reconciliation
 * (reconcileElements.ts) as if it were a real edit -- whose
 * version/versionNonce fields aren't causally comparable across
 * independently-evolved offline copies, and can even be bumped by the
 * Excalidraw plugin just from opening the file, with no user edit at all.
 */
export function needsSyncBaseline(wireRelPath: string): boolean {
  return detectFileType(wireRelPath) === 'excalidraw';
}
