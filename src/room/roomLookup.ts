import { debounce } from 'obsidian';
import type LANotePlugin from '../main';
import type { HostedRoom, JoinedRoom } from '../lib/settingsStore';
import { isWithinSharedFolder, toWireRelPath } from '../lib/syncPaths';

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
  return paths;
}

/** Runs a room's syncConfig() with its standard wiring: excludes paths a live-collab session already owns, and routes remote deletions of a locally-open file through abandonAndCloseFile. */
export function syncRoom(plugin: LANotePlugin, roomId: string, silent: boolean) {
  return plugin.roomRuntimes.get(roomId)?.configSyncEngine.syncConfig(
    silent,
    () => activeWireRelPathsForRoom(plugin, roomId),
    (path) => plugin.abandonAndCloseFile(path)
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

export function assertNoFolderCollision(plugin: LANotePlugin, folder: string, excludeLocalId: string | undefined): void {
  const normalized = folder.replace(/\/+$/, '');
  const all: (HostedRoom | JoinedRoom)[] = [...plugin.settings.hostedRooms, ...plugin.settings.joinedRooms];
  if (all.some(r => r.id !== excludeLocalId && r.sharedFolder.replace(/\/+$/, '') === normalized)) {
    throw new Error(`Folder "${folder}" is already used by another room.`);
  }
}
