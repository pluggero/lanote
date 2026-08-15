import { isWithinSharedFolder } from '../lib/syncPaths';
import type LANotePlugin from '../main';
import type { HostedRoom, JoinedRoom } from '../lib/settingsStore';

export interface RoomPeer {
  name: string;
  color: string;
}

/** Peers currently visible for a room, derived from per-open-file Yjs awareness -- there's no room-wide presence channel, so a peer only shows if they have a file open in this room's folder. */
export function getRoomPeers(plugin: LANotePlugin, room: HostedRoom | JoinedRoom): RoomPeer[] {
  const peers = new Map<string, RoomPeer>();
  for (const [path, sync] of plugin.activeSyncs) {
    if (!isWithinSharedFolder(room.sharedFolder, path)) continue;
    for (const [clientId, state] of sync.awareness.getStates().entries()) {
      if (clientId === sync.awareness.clientID) continue;
      if (state.user?.name) peers.set(state.user.name, state.user);
    }
  }
  return [...peers.values()];
}
