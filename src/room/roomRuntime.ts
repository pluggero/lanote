import type { HostedRoom, JoinedRoom } from '../lib/settingsStore';
import { saveSettings } from '../lib/settingsStore';
import { deriveRoomKeys } from '../lib/crypto';
import { normalizeServerUrl } from '../lib/serverUrl';
import { isWithinSharedFolder } from '../lib/syncPaths';
import { ConfigSyncEngine } from '../sync/configSync';
import type LANotePlugin from '../main';
import { findRoomById } from './roomLookup';
import { teardownSyncSession } from './sessionTeardown';
import { reconnectAll } from '../collab/collabSession';
import { teardownCanvasCardSessionsForRoom } from '../collab/canvasCardSession';
import { updateStatusBar } from '../collab/statusBar';

export async function buildRuntimeForRoom(plugin: LANotePlugin, kind: 'hosted' | 'joined', room: HostedRoom | JoinedRoom): Promise<void> {
  const roomKeys = await deriveRoomKeys(room.roomSecret);
  const serverUrl = normalizeServerUrl(plugin.settings.signalingUrl);
  const configSyncEngine = new ConfigSyncEngine(plugin, serverUrl, roomKeys, room.sharedFolder, room.id);
  plugin.roomRuntimes.set(room.id, { kind, roomKeys, configSyncEngine });
}

/** Disconnects every open-file collab session and canvas card session within this room's folder and tears down its runtime. Does not touch settings or local files. */
export async function teardownRuntimeForRoom(plugin: LANotePlugin, localRoomId: string): Promise<void> {
  const match = findRoomById(plugin, localRoomId);
  if (match) {
    for (const [path, sync] of [...plugin.activeSyncs.entries()]) {
      if (isWithinSharedFolder(match.room.sharedFolder, path)) {
        await teardownSyncSession(plugin, path, sync);
      }
    }
    await teardownCanvasCardSessionsForRoom(plugin, match.room.sharedFolder);
  }
  plugin.roomRuntimes.delete(localRoomId);
  plugin.backgroundSyncDebouncers.delete(localRoomId);
}

/** Called on load and whenever a setting affecting every room (e.g. the server URL) changes: rebuilds every room's runtime and every active collab session from scratch. */
export async function reinitializeAllRooms(plugin: LANotePlugin): Promise<void> {
  await saveSettings(plugin);
  for (const localId of [...plugin.roomRuntimes.keys()]) {
    await teardownRuntimeForRoom(plugin, localId);
  }
  for (const room of plugin.settings.hostedRooms) {
    if (room.sharingActive) await buildRuntimeForRoom(plugin, 'hosted', room);
  }
  for (const room of plugin.settings.joinedRooms) {
    await buildRuntimeForRoom(plugin, 'joined', room);
  }
  reconnectAll(plugin);
  updateStatusBar(plugin);
}
