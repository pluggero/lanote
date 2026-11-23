import type { App } from 'obsidian';
import type { PendingDeletion } from './configSync';

/** Single-burst heuristic; a deletion staggered across many sync passes, each under threshold, is not detected. */
export const MIN_DELETED_FILES = 3;
export const MIN_DELETED_FRACTION = 0.5;

/** @param totalBeforeCount Files present immediately before this deletion, including the ones being deleted. */
export function isMassDeletion(deletedCount: number, totalBeforeCount: number): boolean {
  if (deletedCount < MIN_DELETED_FILES) return false;
  return deletedCount / Math.max(totalBeforeCount, deletedCount) >= MIN_DELETED_FRACTION;
}

/** A file that stays in the shared folder after this sync pass. */
export interface SurvivingFile {
  path: string; // vault-relative
  size: number;
}

/** Splits deletions into moves (identical content survives elsewhere) and real losses. */
export async function splitMoves(
  app: App,
  pending: PendingDeletion[],
  survivors: SurvivingFile[]
): Promise<{ moved: PendingDeletion[]; lost: PendingDeletion[] }> {
  const moved: PendingDeletion[] = [];
  const lost: PendingDeletion[] = [];
  for (const deletion of pending) {
    (await survivesElsewhere(app, deletion.vaultRelPath, survivors) ? moved : lost).push(deletion);
  }
  return { moved, lost };
}

async function survivesElsewhere(app: App, vaultRelPath: string, survivors: SurvivingFile[]): Promise<boolean> {
  const stat = await app.vault.adapter.stat(vaultRelPath);
  if (!stat) return false;
  const sameSize = survivors.filter(s => s.size === stat.size); // Only same-size files can match; avoids reading the rest.
  if (sameSize.length === 0) return false;
  const data = await app.vault.adapter.readBinary(vaultRelPath);
  for (const candidate of sameSize) {
    if (bytesEqual(data, await app.vault.adapter.readBinary(candidate.path))) return true;
  }
  return false;
}

function bytesEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}
