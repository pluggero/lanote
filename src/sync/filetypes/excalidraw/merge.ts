import { App } from 'obsidian';
import * as Y from 'yjs';
import { reconcileYElements } from '../../../reconcile';
import type { SyncTransport } from '../../syncTransport';
import { commitMergedFile, resolveByLatestMtime } from '../../mtimeWins';
import { parseExcalidrawMd, serializeExcalidrawMd, type ExcalidrawElementLike, type ExcalidrawFileParts } from './codec';
import { reconcileElementArrays, mergeFilesMaps } from './reconcileElements';

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
 * Automatically merges a conflicting drawing at the element level instead
 * of as text: fetches the last CRDT snapshot of the scene's elements (if
 * any), reconciles both the local and remote files' elements into it by
 * id/version (see reconcileElements.ts), and writes the merged scene back.
 * Falls back to silent latest-mtime-wins if either side doesn't parse as a
 * *.excalidraw.md file, since there's nothing to merge at the element level
 * in that case.
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

    // First-ever conflict for this drawing: seed the CRDT from the remote
    // side's elements before folding in local edits, mirroring the
    // markdown resolver's "seed from remote, then reconcile local on top".
    if (yElements.size === 0) {
      doc.transact(() => {
        for (const element of remote.sceneData.elements) yElements.set(element.id, element);
      });
    }

    const merged = reconcileElementArrays(Array.from(yElements.values()), local.sceneData.elements);
    reconcileYElements(yElements, merged);

    const mergedUpdate = Y.encodeStateAsUpdate(doc);
    await transport.putRoomStateSnapshot(wireRelPath, mergedUpdate);

    // appState (viewport position, selected tool, zoom, ...) is per-device
    // UI state, not meaningfully mergeable element-by-element -- keep it,
    // and the rest of the shell (frontmatter, Text Elements section), from
    // whichever copy was edited most recently.
    const newerShell: ExcalidrawFileParts = localMtime >= remoteMtime ? local : remote;
    const mergedParts: ExcalidrawFileParts = {
      shellPrefix: newerShell.shellPrefix,
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
