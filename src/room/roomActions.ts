import { Notice } from 'obsidian';
import type { HostedRoom, JoinedRoom } from '../lib/settingsStore';
import { saveSettings } from '../lib/settingsStore';
import { generateRoomSecret } from '../lib/crypto';
import { ensureFolderExists } from '../lib/vaultFs';
import { isWithinSharedFolder } from '../lib/syncPaths';
import type LANotePlugin from '../main';
import { findRoomById, assertNoFolderCollision, syncRoom } from './roomLookup';
import { buildRuntimeForRoom, teardownRuntimeForRoom } from './roomRuntime';
import { teardownSyncSession } from './sessionTeardown';
import { reconnectAll } from '../collab/collabSession';
import { teardownCanvasCardSessionsForRoom } from '../collab/canvasCardSession';
import { updateStatusBar } from '../collab/statusBar';

export async function createRoom(plugin: LANotePlugin, sharedFolder: string): Promise<HostedRoom> {
  assertNoFolderCollision(plugin, sharedFolder, undefined);
  await ensureFolderExists(plugin.app, sharedFolder);
  const room: HostedRoom = {
    id: crypto.randomUUID(),
    roomSecret: generateRoomSecret(),
    sharedFolder,
    sharingActive: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  plugin.settings.hostedRooms.push(room);
  await saveSettings(plugin);
  return room;
}

export async function startSharing(plugin: LANotePlugin, localRoomId: string): Promise<void> {
  const room = plugin.settings.hostedRooms.find(r => r.id === localRoomId);
  if (!room) throw new Error('Room not found');
  if (!(await plugin.app.vault.adapter.exists(room.sharedFolder))) {
    throw new Error(`Folder "${room.sharedFolder}" no longer exists. Choose a folder before starting sharing.`);
  }
  room.sharingActive = true;
  room.updatedAt = Date.now();
  await saveSettings(plugin);
  await buildRuntimeForRoom(plugin, 'hosted', room);
  await syncRoom(plugin, room.id, false);
  reconnectAll(plugin);
  updateStatusBar(plugin);
}

/** Stops sharing: best-effort deletes this room's files+state on the server, then tears down the local runtime. Local vault files are never touched. */
export async function stopSharing(plugin: LANotePlugin, localRoomId: string): Promise<void> {
  const room = plugin.settings.hostedRooms.find(r => r.id === localRoomId);
  if (!room) throw new Error('Room not found');
  const runtime = plugin.roomRuntimes.get(room.id);
  if (runtime) {
    try {
      await runtime.configSyncEngine.deleteRoomOnServer();
    } catch (e: any) {
      new Notice(`Warning: could not confirm server-side cleanup for this room (${e.message || e}). Local files are safe; you may need to clean up the server manually later.`, 8000);
    }
  }
  room.sharingActive = false;
  room.updatedAt = Date.now();
  await saveSettings(plugin);
  await teardownRuntimeForRoom(plugin, room.id);
  updateStatusBar(plugin);
}

/** Removes a hosted room from the list. Only valid while not sharing -- callers should disable this control while sharingActive. */
export async function deleteHostedRoom(plugin: LANotePlugin, localRoomId: string): Promise<void> {
  const room = plugin.settings.hostedRooms.find(r => r.id === localRoomId);
  if (!room) return;
  if (room.sharingActive) throw new Error('Stop sharing before removing this room from the list.');
  plugin.settings.hostedRooms = plugin.settings.hostedRooms.filter(r => r.id !== localRoomId);
  await saveSettings(plugin);
}

/**
 * Renews a hosted room's ID. A secret change is not an in-place rotation --
 * files uploaded under the old id are unreachable under the new derived
 * keys, so if the room was sharing, this stops sharing (deleting the old
 * server-side room) before restarting fresh under the new secret.
 */
export async function renewRoomId(plugin: LANotePlugin, localRoomId: string): Promise<void> {
  const room = plugin.settings.hostedRooms.find(r => r.id === localRoomId);
  if (!room) throw new Error('Room not found');
  const wasSharing = room.sharingActive;
  if (wasSharing) {
    await stopSharing(plugin, localRoomId);
  }
  room.roomSecret = generateRoomSecret();
  room.updatedAt = Date.now();
  await saveSettings(plugin);
  if (wasSharing) {
    await startSharing(plugin, localRoomId);
  }
}

export async function joinRoom(plugin: LANotePlugin, roomSecret: string, sharedFolder: string): Promise<JoinedRoom> {
  assertNoFolderCollision(plugin, sharedFolder, undefined);
  await ensureFolderExists(plugin.app, sharedFolder);
  const room: JoinedRoom = {
    id: crypto.randomUUID(),
    roomSecret,
    sharedFolder,
    joinedAt: Date.now(),
  };
  plugin.settings.joinedRooms.push(room);
  await saveSettings(plugin);
  await buildRuntimeForRoom(plugin, 'joined', room);
  await syncRoom(plugin, room.id, false);
  reconnectAll(plugin);
  updateStatusBar(plugin);
  return room;
}

/** Disconnects and removes a joined room from the list. No server call, and local files are never deleted. */
export async function leaveRoom(plugin: LANotePlugin, localRoomId: string): Promise<void> {
  const room = plugin.settings.joinedRooms.find(r => r.id === localRoomId);
  if (!room) return;
  await teardownRuntimeForRoom(plugin, room.id);
  plugin.settings.joinedRooms = plugin.settings.joinedRooms.filter(r => r.id !== localRoomId);
  await saveSettings(plugin);
  updateStatusBar(plugin);
}

export async function reconstructDatabase(plugin: LANotePlugin, localRoomId: string): Promise<void> {
  const match = findRoomById(plugin, localRoomId);
  const runtime = plugin.roomRuntimes.get(localRoomId);
  if (!match || !runtime) {
    new Notice('This room is not currently active.');
    return;
  }

  try {
    new Notice('Resetting and reconstructing server database for this room...', 3000);

    // 1. Disconnect and clear this room's active docs locally
    for (const [path, sync] of [...plugin.activeSyncs.entries()]) {
      if (!isWithinSharedFolder(match.room.sharedFolder, path)) continue;
      await teardownSyncSession(plugin, path, sync);
    }
    await teardownCanvasCardSessionsForRoom(plugin, match.room.sharedFolder);

    // 2. Clear this room's CRDT snapshots on the server (files themselves are untouched)
    await runtime.configSyncEngine.reconstructRoom();

    new Notice('Server room state cleared. Re-uploading all files as source of truth...', 3500);

    // 3. Force full folder re-upload
    await syncRoom(plugin, localRoomId, false);

    // 4. Reconnect active workspace leaves
    reconnectAll(plugin);

    new Notice('Database successfully reconstructed! All devices will resync.', 4000);
  } catch (err: any) {
    console.error('[LANote] Database reconstruction failed:', err);
    new Notice(`Database reconstruction failed: ${err.message || err}`, 5000);
  }
}
