import { App } from 'obsidian';
import * as Y from 'yjs';
import { reconcileYText } from '../reconcile';
import { writeBinaryFile } from '../vaultFs';
import type { SyncTransport } from './syncTransport';

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
 * Automatically merges a conflicting note via its Yjs room-state history:
 * fetches the last CRDT snapshot (if any), reconciles local disk content
 * into it, and pushes the merged result back. Falls back to silent
 * latest-mtime-wins if the merge itself fails.
 *
 * Returns false if a live-collab session raced in and became the
 * authoritative owner of this file partway through the merge -- the caller
 * should skip this file entirely (no action counted) rather than write a
 * snapshot/file body derived from what may now be stale data.
 */
export async function resolveMarkdownConflict(ctx: MarkdownConflictContext): Promise<boolean> {
  const { app, transport, wireRelPath, vaultRelPath, localData, remoteData, localMtime, remoteMtime, getActiveLivePaths } = ctx;
  try {
    console.log(`[LANote] Automatically merging CRDT conflict for note: ${wireRelPath}`);

    // 1. Fetch and decrypt the server's Yjs room state snapshot, if any
    const doc = new Y.Doc();
    const snapshot = await transport.getRoomStateSnapshot(wireRelPath);
    if (snapshot) {
      Y.applyUpdate(doc, snapshot);
    }

    // A live session can start between the top-of-loop check and here --
    // that GET above already raced it once. Bail out of the merge entirely
    // rather than writing a snapshot/file body derived from a read that may
    // already be stale; the live session is now the authoritative owner.
    if (getActiveLivePaths().has(wireRelPath)) return false;

    // 2. Read the local disk file content
    const decoder = new TextDecoder('utf-8');
    const localText = decoder.decode(new Uint8Array(localData));

    // 3. Reconcile the Yjs document with our local offline edits
    const ytext = doc.getText('content');

    // If the Yjs doc was empty, initialize it with the remote content first
    if (ytext.toString() === '') {
      const remoteText = decoder.decode(new Uint8Array(remoteData));
      ytext.insert(0, remoteText);
    }

    if (ytext.toString() === localText) {
      // Room-state already has this exact content -- a live
      // session already correctly converged it there. This
      // "conflict" is really just a stale file-body manifest
      // entry (live edits never re-upload the body). Re-upload
      // to align the manifest and stop here: POSTing a re-
      // derived room-state snapshot here has no compare-and-
      // swap on the server, so doing it unconditionally risks
      // clobbering a newer update a live session pushes in the
      // gap between our GET above and a POST here.
      const encoder = new TextEncoder();
      await transport.uploadFile(wireRelPath, encoder.encode(localText).buffer, Date.now());
      console.log(`[LANote] Realigned stale file-body manifest for note: ${wireRelPath}`);
    } else {
      // Reconcile with local text to merge offline edits cleanly
      reconcileYText(ytext, localText);

      // 4. Encrypt and send the merged state as a Yjs update
      const mergedUpdate = Y.encodeStateAsUpdate(doc);
      await transport.putRoomStateSnapshot(wireRelPath, mergedUpdate);

      // 5. Write the merged text back to our local disk file, and upload it
      //    explicitly -- unlike the old plaintext server, this server never
      //    derives the file side from a room-state snapshot on its own.
      const mergedText = ytext.toString();
      const encoder = new TextEncoder();
      const mergedBytes = encoder.encode(mergedText).buffer;
      await writeBinaryFile(app, vaultRelPath, mergedBytes);
      await transport.uploadFile(wireRelPath, mergedBytes, Date.now());

      console.log(`[LANote] CRDT merge successful for note: ${wireRelPath}`);
    }
  } catch (crdtErr) {
    console.error(`[LANote] CRDT merge failed for ${wireRelPath}, falling back to silent mtime resolution:`, crdtErr);
    // Fallback: Silent latest modified wins (Zero Conflicts Protocol!)
    if (localMtime > remoteMtime) {
      await transport.uploadFile(wireRelPath, localData, localMtime);
    } else {
      await writeBinaryFile(app, vaultRelPath, remoteData);
    }
  }
  return true;
}
