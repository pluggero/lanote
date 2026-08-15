import { App } from 'obsidian';
import * as Y from 'yjs';
import { reconcileYElements } from '../../../lib/reconcile';
import type { SyncTransport } from '../../syncTransport';
import { commitMergedFile, resolveByLatestMtime } from '../../mtimeWins';
import { parseExcalidrawMd, serializeExcalidrawMd, type ExcalidrawElementLike, type ExcalidrawFileParts } from './codec';
import { reconcileElementArrays, mergeFilesMaps, patchTextElementsMirror } from './reconcileElements';

export interface ExcalidrawConflictContext {
  app: App;
  transport: SyncTransport;
  wireRelPath: string;
  vaultRelPath: string;
  localData: ArrayBuffer;
  remoteData: ArrayBuffer;
  localMtime: number;
  remoteMtime: number;
}

/**
 * Merges a conflicting drawing at the element level: fetches the scene's
 * CRDT snapshot, reconciles local/remote elements into it by id/version
 * (reconcileElements.ts), and writes the merged scene back. Falls back to
 * latest-mtime-wins if either side doesn't parse as a *.excalidraw.md file.
 */
export async function resolveExcalidrawConflict(ctx: ExcalidrawConflictContext): Promise<void> {
  const { app, transport, wireRelPath, vaultRelPath, localData, remoteData, localMtime, remoteMtime } = ctx;
  try {
    const decoder = new TextDecoder('utf-8');
    const local = parseExcalidrawMd(decoder.decode(localData));
    const remote = parseExcalidrawMd(decoder.decode(remoteData));
    if (!local || !remote) throw new Error(`local or remote copy of ${wireRelPath} did not parse as a *.excalidraw.md file`);

    // Fetch the server's Yjs room-state snapshot of this drawing's elements, if any.
    const doc = new Y.Doc();
    const snapshot = await transport.getRoomStateSnapshot(wireRelPath);
    if (snapshot) Y.applyUpdate(doc, snapshot);
    const yElements = doc.getMap<ExcalidrawElementLike>('elements');

    // First-ever conflict: seed the CRDT from remote before folding in local edits.
    if (yElements.size === 0) {
      doc.transact(() => {
        for (const element of remote.sceneData.elements) yElements.set(element.id, element);
      });
    }

    const merged = reconcileElementArrays(Array.from(yElements.values()), local.sceneData.elements);
    reconcileYElements(yElements, merged);

    const mergedUpdate = Y.encodeStateAsUpdate(doc);
    await transport.putRoomStateSnapshot(wireRelPath, mergedUpdate);

    // appState (viewport, tool, zoom) is per-device UI state, not
    // meaningfully mergeable -- keep it and the rest of the shell from
    // whichever copy was edited most recently.
    const newerShell: ExcalidrawFileParts = localMtime >= remoteMtime ? local : remote;
    const mergedParts: ExcalidrawFileParts = {
      shellPrefix: patchTextElementsMirror(newerShell.shellPrefix, merged),
      shellSuffix: newerShell.shellSuffix,
      sceneData: {
        ...newerShell.sceneData,
        elements: merged,
        files: mergeFilesMaps(local.sceneData.files, remote.sceneData.files),
      },
    };

    const encoder = new TextEncoder();
    const mergedBytes = encoder.encode(serializeExcalidrawMd(mergedParts)).buffer;
    const mergedMtime = Date.now();
    await commitMergedFile(app, transport, wireRelPath, vaultRelPath, mergedBytes, mergedMtime);
    console.log(`[LANote] Element-level merge successful for drawing: ${wireRelPath}`);
  } catch (mergeErr) {
    console.error(`[LANote] Excalidraw merge failed for ${wireRelPath}, falling back to silent mtime resolution:`, mergeErr);
    await resolveByLatestMtime({ app, transport, wireRelPath, vaultRelPath, localData, remoteData, localMtime, remoteMtime });
  }
}
