import { App } from 'obsidian';
import * as Y from 'yjs';
import { reconcileYText } from '../../../lib/reconcile';
import type { SyncTransport } from '../../syncTransport';
import { commitMergedFile, resolveByLatestMtime } from '../../mtimeWins';

export interface MarkdownConflictContext {
  app: App;
  transport: SyncTransport;
  wireRelPath: string;
  vaultRelPath: string;
  localData: ArrayBuffer;
  remoteData: ArrayBuffer;
  localMtime: number;
  remoteMtime: number;
  getActiveLivePaths: () => Set<string>;
}

/**
 * Merges a conflicting note via its Yjs room-state history: fetches the
 * CRDT snapshot, reconciles local disk content into it, pushes the merged
 * result back. Falls back to latest-mtime-wins on failure. Returns false if
 * a live session raced in and became authoritative owner partway through --
 * the caller should skip this file rather than write data that may now be stale.
 */
export async function resolveMarkdownConflict(ctx: MarkdownConflictContext): Promise<boolean> {
  const { app, transport, wireRelPath, vaultRelPath, localData, remoteData, localMtime, remoteMtime, getActiveLivePaths } = ctx;
  try {
    console.log(`[LANote] Automatically merging CRDT conflict for note: ${wireRelPath}`);

    // Fetch and decrypt the server's Yjs room-state snapshot, if any.
    const doc = new Y.Doc();
    const snapshot = await transport.getRoomStateSnapshot(wireRelPath);
    if (snapshot) {
      Y.applyUpdate(doc, snapshot);
    }

    // A live session can start between the top-of-loop check and here.
    // Bail rather than write data derived from a now-possibly-stale read.
    if (getActiveLivePaths().has(wireRelPath)) return false;

    const decoder = new TextDecoder('utf-8');
    const localText = decoder.decode(new Uint8Array(localData));

    const ytext = doc.getText('content');

    // If the Yjs doc was empty, initialize it with the remote content first.
    if (ytext.toString() === '') {
      const remoteText = decoder.decode(new Uint8Array(remoteData));
      ytext.insert(0, remoteText);
    }

    if (ytext.toString() === localText) {
      // Room-state already matches -- this "conflict" is just a stale
      // file-body manifest entry (live edits never re-upload the body).
      // Re-upload to align it and stop; the server has no compare-and-swap,
      // so re-POSTing room-state here risks clobbering a newer live update.
      const encoder = new TextEncoder();
      await transport.uploadFile(wireRelPath, encoder.encode(localText).buffer, Date.now());
      console.log(`[LANote] Realigned stale file-body manifest for note: ${wireRelPath}`);
    } else {
      // Reconcile with local text to merge offline edits cleanly.
      reconcileYText(ytext, localText);

      const mergedUpdate = Y.encodeStateAsUpdate(doc);
      await transport.putRoomStateSnapshot(wireRelPath, mergedUpdate);

      // Both the disk file and the server's file-body manifest need the
      // merged text: the server never derives a file's body from its
      // room-state snapshot on its own.
      const mergedText = ytext.toString();
      const encoder = new TextEncoder();
      const mergedBytes = encoder.encode(mergedText).buffer;
      const mergedMtime = Date.now();
      await commitMergedFile(app, transport, wireRelPath, vaultRelPath, mergedBytes, mergedMtime);

      console.log(`[LANote] CRDT merge successful for note: ${wireRelPath}`);
    }
  } catch (crdtErr) {
    console.error(`[LANote] CRDT merge failed for ${wireRelPath}, falling back to silent mtime resolution:`, crdtErr);
    await resolveByLatestMtime({ app, transport, wireRelPath, vaultRelPath, localData, remoteData, localMtime, remoteMtime });
  }
  return true;
}
