import { Setting } from 'obsidian';
import { isWithinSharedFolder } from '../syncPaths';
import type LANotePlugin from '../main';
import type { JoinedRoom } from '../settingsStore';
import { renderRoomListItem, type BadgeVariant, type RoomListItemAction, type RoomListItemHandle } from './RoomListItem';
import { getRoomPeers } from './roomPeers';
import { ConfirmModal, JoinRoomModal } from './modals';

/** Renders the Join Room section and returns one peer-list handle per joined room, in settings order, for the live peer-refresh loop. */
export function renderJoinRoomSection(containerEl: HTMLElement, plugin: LANotePlugin, rerender: () => void): RoomListItemHandle[] {
  containerEl.createEl('h3', { cls: 'lanote-section-header', text: 'Join Room' });

  new Setting(containerEl)
    .setName('Join a room')
    .setDesc('Been given a room code by someone else? Paste it in and pick (or name) a folder to receive their shared content.')
    .addButton(btn => btn
      .setButtonText('+ Join Room')
      .setCta()
      .onClick(() => {
        new JoinRoomModal(plugin.app, plugin, rerender).open();
      }));

  if (plugin.settings.joinedRooms.length === 0) {
    containerEl.createDiv({ cls: 'lanote-empty-state', text: "You haven't joined any rooms yet. Click '+ Join Room' and enter a room ID." });
    return [];
  }

  const list = containerEl.createDiv({ cls: 'lanote-room-list' });
  return plugin.settings.joinedRooms.map(room => renderRoomListItem({
    containerEl: list,
    roomIdLabel: room.roomSecret,
    folderPath: room.sharedFolder,
    statusBadge: connectionBadge(plugin, room),
    peers: getRoomPeers(plugin, room),
    actions: buildJoinedRoomActions(plugin, room, rerender),
  }));
}

function connectionBadge(plugin: LANotePlugin, room: JoinedRoom): { text: string; variant: BadgeVariant } {
  let connected = 0;
  let connecting = 0;
  let total = 0;
  for (const [path, sync] of plugin.activeSyncs) {
    if (!isWithinSharedFolder(room.sharedFolder, path)) continue;
    total++;
    if (!sync.provider) continue;
    if (sync.provider.wsconnected) connected++;
    else if (sync.provider.shouldConnect) connecting++;
  }
  if (connected > 0) return { text: 'Connected', variant: 'connected' };
  if (connecting > 0) return { text: 'Connecting', variant: 'connecting' };
  if (total > 0) return { text: 'Disconnected', variant: 'disconnected' };
  return { text: 'Standby', variant: 'disconnected' };
}

function buildJoinedRoomActions(plugin: LANotePlugin, room: JoinedRoom, rerender: () => void): RoomListItemAction[] {
  return [
    {
      label: 'Sync Now',
      onClick: async () => {
        await plugin.roomRuntimes.get(room.id)?.configSyncEngine.syncConfig(false, () => plugin.activeWireRelPathsForRoom(room.id));
      },
    },
    {
      label: 'Leave',
      warning: true,
      onClick: () => {
        new ConfirmModal(plugin.app, {
          title: 'Leave this room?',
          body: `You'll stop syncing with this room and it will be removed from your list. Your local files in "${room.sharedFolder}" will NOT be deleted.`,
          confirmText: 'Leave Room',
          warning: true,
          onConfirm: async () => {
            await plugin.leaveRoom(room.id);
            rerender();
          },
        }).open();
      },
    },
  ];
}
