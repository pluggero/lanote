import { debounce } from 'obsidian';
import type LANotePlugin from '../main';
import type { HostedRoom, JoinedRoom } from '../lib/settingsStore';
import { isWithinSharedFolder, toWireRelPath } from '../lib/syncPaths';
import { countFiles } from '../lib/vaultFs';
import { isMassDeletion } from '../sync/massDeletionGuard';
import { addPendingExclusion, removePendingExclusion, getPendingExclusions } from './pendingSyncPaths';
import { promptReceivedMassDeletion, confirmSentMassDeletion } from './massDeletionPrompt';

/** Local deletes not yet pushed for one room. */
interface DeleteBatch {
  deletes: Map<string, string>; // vault path -> wire path, fixed at queue time
  totalBefore: number; // files in the folder before the batch's first delete
  prompting: boolean;
}
const deleteBatches = new Map<string, DeleteBatch>();

export function findRoomById(plugin: LANotePlugin, id: string): { room: HostedRoom | JoinedRoom; kind: 'hosted' | 'joined' } | null {
  const hosted = plugin.settings.hostedRooms.find(r => r.id === id);
  if (hosted) return { room: hosted, kind: 'hosted' };
  const joined = plugin.settings.joinedRooms.find(r => r.id === id);
  if (joined) return { room: joined, kind: 'joined' };
  return null;
}

/** Which room (if any) owns a given vault-relative path -- the sharingActive hosted room or joined room whose folder most specifically contains it. */
export function findHostedOrJoinedRoomForPath(plugin: LANotePlugin, path: string): { room: HostedRoom | JoinedRoom; kind: 'hosted' | 'joined' } | null {
  let best: { room: HostedRoom | JoinedRoom; kind: 'hosted' | 'joined' } | null = null;
  let bestLen = -1;
  for (const room of plugin.settings.hostedRooms) {
    if (room.sharingActive && isWithinSharedFolder(room.sharedFolder, path) && room.sharedFolder.length > bestLen) {
      best = { room, kind: 'hosted' };
      bestLen = room.sharedFolder.length;
    }
  }
  for (const room of plugin.settings.joinedRooms) {
    if (isWithinSharedFolder(room.sharedFolder, path) && room.sharedFolder.length > bestLen) {
      best = { room, kind: 'joined' };
      bestLen = room.sharedFolder.length;
    }
  }
  return best;
}

/**
 * Wire-relative paths (within the given room's shared folder) that
 * currently have an active live-collab session. Pass this into
 * syncConfig() so the REST-based background sync never touches a file the
 * live session already owns -- see syncConfig()'s own doc comment for why
 * that matters (an uncoordinated second writer of the same room-state
 * causes a runaway conflict loop, not a one-time glitch).
 *
 * Also includes the owning file of any canvas card with a connected live
 * session (plugin.activeCardSyncs): the card only guarantees disk
 * persistence via a single write on focus-loss, so the file must stay
 * excluded until then. Gated on `wsconnected`, not mere session existence,
 * so a dropped connection (no reconnect attempt) falls back to background
 * merge coverage instead of excluding the file indefinitely.
 */
export function activeWireRelPathsForRoom(plugin: LANotePlugin, localRoomId: string): Set<string> {
  const match = findRoomById(plugin, localRoomId);
  const paths = new Set<string>();
  if (!match) return paths;
  for (const vaultRelPath of plugin.activeSyncs.keys()) {
    if (isWithinSharedFolder(match.room.sharedFolder, vaultRelPath)) {
      paths.add(toWireRelPath(match.room.sharedFolder, vaultRelPath));
    }
  }
  for (const binding of plugin.activeCardSyncs.values()) {
    if (binding.sync.provider?.wsconnected && isWithinSharedFolder(match.room.sharedFolder, binding.vaultRelPath)) {
      paths.add(toWireRelPath(match.room.sharedFolder, binding.vaultRelPath));
    }
  }
  return paths;
}

/** Runs a room's syncConfig() with its standard wiring: excludes live-session and pending-mass-deletion paths, routes remote deletions of an open file through abandonAndCloseFile, and prompts before an accidental-looking deletion is applied. */
export function syncRoom(plugin: LANotePlugin, roomId: string, silent: boolean) {
  return plugin.roomRuntimes.get(roomId)?.configSyncEngine.syncConfig(
    silent,
    () => activeWireRelPathsForRoom(plugin, roomId),
    (path) => plugin.abandonAndCloseFile(path),
    () => getPendingExclusions(roomId),
    (pending, totalBefore) => {
      const match = findRoomById(plugin, roomId);
      if (match) promptReceivedMassDeletion(plugin, roomId, match.room.sharedFolder, pending, totalBefore);
    }
  );
}

export function getBackgroundSyncDebouncer(plugin: LANotePlugin, roomId: string): () => void {
  let fn = plugin.backgroundSyncDebouncers.get(roomId);
  if (!fn) {
    fn = debounce(() => { syncRoom(plugin, roomId, true); }, 5000, true);
    plugin.backgroundSyncDebouncers.set(roomId, fn);
  }
  return fn;
}

// Delay before a small batch is pushed; a mass deletion prompts immediately.
const DELETE_QUIET_WINDOW_MS = 3000;

/** Queues a local delete; checks the mass-deletion threshold on every delete. */
export function getMassDeletionFlusher(plugin: LANotePlugin, roomId: string): (vaultRelPath: string) => void {
  let trigger = plugin.massDeletionFlushers.get(roomId);
  if (!trigger) {
    trigger = debounce(() => { void flushQuietBatch(plugin, roomId, true); }, DELETE_QUIET_WINDOW_MS, true);
    plugin.massDeletionFlushers.set(roomId, trigger);
  }
  const armedTrigger = trigger;

  return (vaultRelPath: string) => {
    const match = findRoomById(plugin, roomId);
    if (!match) return;
    let batch = deleteBatches.get(roomId);
    if (!batch) {
      // The vault index no longer holds this file, hence + 1.
      batch = { deletes: new Map(), totalBefore: countFiles(plugin.app, match.room.sharedFolder) + 1, prompting: false };
      deleteBatches.set(roomId, batch);
    }
    // One hold per queued path, released when the batch settles.
    if (!batch.deletes.has(vaultRelPath)) {
      const wireRelPath = toWireRelPath(match.room.sharedFolder, vaultRelPath);
      batch.deletes.set(vaultRelPath, wireRelPath);
      addPendingExclusion(roomId, [wireRelPath]);
    }
    if (batch.prompting) return; // The open prompt's decision covers this delete too.
    if (isMassDeletion(batch.deletes.size, batch.totalBefore)) {
      armedTrigger.cancel();
      void promptForBatch(plugin, roomId, match.room.sharedFolder, batch);
    } else {
      armedTrigger();
    }
  };
}

/** Pushes the room's pending small batch and drops its flusher. Used on room teardown and plugin unload. */
export async function disposeMassDeletionQueue(plugin: LANotePlugin, roomId: string): Promise<void> {
  plugin.massDeletionFlushers.get(roomId)?.cancel();
  plugin.massDeletionFlushers.delete(roomId);
  await flushQuietBatch(plugin, roomId, false);
}

/** Below the threshold by construction: pushed without asking. */
async function flushQuietBatch(plugin: LANotePlugin, roomId: string, triggerSync: boolean): Promise<void> {
  const batch = deleteBatches.get(roomId);
  if (!batch || batch.prompting) return; // An open prompt owns its batch.
  deleteBatches.delete(roomId);
  await settleBatch(plugin, roomId, batch, true);
  if (triggerSync) getBackgroundSyncDebouncer(plugin, roomId)();
}

async function promptForBatch(plugin: LANotePlugin, roomId: string, sharedFolder: string, batch: DeleteBatch): Promise<void> {
  batch.prompting = true;
  const push = await confirmSentMassDeletion(plugin, sharedFolder, [...batch.deletes.values()], batch.totalBefore);
  // Taken only now, so deletes made while the prompt was open are included.
  if (deleteBatches.get(roomId) === batch) deleteBatches.delete(roomId);
  await settleBatch(plugin, roomId, batch, push);

  // After the release: excluded paths would be skipped by this sync.
  if (push) getBackgroundSyncDebouncer(plugin, roomId)();
  else void syncRoom(plugin, roomId, false);
}

/** Optionally pushes the batch's deletes; always releases their holds. */
async function settleBatch(plugin: LANotePlugin, roomId: string, batch: DeleteBatch, push: boolean): Promise<void> {
  try {
    // Looked up now: the runtime may have been rebuilt since the deletes were queued.
    const engine = plugin.roomRuntimes.get(roomId)?.configSyncEngine;
    if (!push || !engine) return;
    for (const vaultRelPath of batch.deletes.keys()) {
      // Recreated since: pushing would delete the new file on every peer.
      if (plugin.app.vault.getAbstractFileByPath(vaultRelPath)) continue;
      await engine.deleteRemoteFile(vaultRelPath);
    }
  } finally {
    removePendingExclusion(roomId, batch.deletes.values());
  }
}

export function assertNoFolderCollision(plugin: LANotePlugin, folder: string, excludeLocalId: string | undefined): void {
  const normalized = folder.replace(/\/+$/, '');
  const all: (HostedRoom | JoinedRoom)[] = [...plugin.settings.hostedRooms, ...plugin.settings.joinedRooms];
  if (all.some(r => r.id !== excludeLocalId && r.sharedFolder.replace(/\/+$/, '') === normalized)) {
    throw new Error(`Folder "${folder}" is already used by another room.`);
  }
}
