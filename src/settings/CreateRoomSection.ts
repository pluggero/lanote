import { Notice, Setting } from 'obsidian';
import type LANotePlugin from '../main';
import type { HostedRoom } from '../lib/settingsStore';
import { syncRoom } from '../room/roomLookup';
import { renderRoomListItem, type RoomListItemAction, type RoomListItemHandle } from './RoomListItem';
import { getRoomPeers } from './roomPeers';
import { ConfirmModal, NewRoomModal } from './modals';

/** Renders the Create Room section and returns one peer-list handle per hosted room, in settings order, for the live peer-refresh loop. */
export function renderCreateRoomSection(containerEl: HTMLElement, plugin: LANotePlugin, rerender: () => void): RoomListItemHandle[] {
  containerEl.createEl('h3', { cls: 'lanote-section-header', text: 'Create Room' });

  new Setting(containerEl)
    .setName('Host a new room')
    .setDesc('Share a folder from this vault. You control when sharing starts and stops, and can renew the room ID at any time.')
    .addButton(btn => btn
      .setButtonText('+ New Room')
      .setCta()
      .onClick(() => {
        new NewRoomModal(plugin.app, async (folder) => {
          try {
            await plugin.createRoom(folder);
            rerender();
          } catch (e: any) {
            new Notice(e.message || String(e));
          }
        }).open();
      }));

  if (plugin.settings.hostedRooms.length === 0) {
    containerEl.createDiv({ cls: 'lanote-empty-state', text: "You haven't created any rooms yet. Click '+ New Room' to share a folder." });
    return [];
  }

  const list = containerEl.createDiv({ cls: 'lanote-room-list' });
  return plugin.settings.hostedRooms.map(room => renderRoomListItem({
    containerEl: list,
    roomIdLabel: room.roomSecret,
    folderPath: room.sharedFolder,
    statusBadge: room.sharingActive ? { text: 'Sharing', variant: 'sharing' } : { text: 'Stopped', variant: 'stopped' },
    peers: getRoomPeers(plugin, room),
    actions: buildHostedRoomActions(plugin, room, rerender),
  }));
}

function buildHostedRoomActions(plugin: LANotePlugin, room: HostedRoom, rerender: () => void): RoomListItemAction[] {
  const actions: RoomListItemAction[] = [];

  actions.push({
    label: room.sharingActive ? 'Stop Sharing' : 'Start Sharing',
    warning: room.sharingActive,
    onClick: () => {
      if (room.sharingActive) {
        new ConfirmModal(plugin.app, {
          title: 'Stop sharing this room?',
          body: `This deletes this room's files and history from the server. Your local files in "${room.sharedFolder}" are not touched. Anyone currently connected will be disconnected.`,
          confirmText: 'Stop Sharing',
          warning: true,
          onConfirm: async () => {
            await plugin.stopSharing(room.id);
            rerender();
          },
        }).open();
      } else {
        (async () => {
          try {
            await plugin.startSharing(room.id);
          } catch (e: any) {
            new Notice(e.message || String(e));
          }
          rerender();
        })();
      }
    },
  });

  actions.push({
    label: 'Renew ID',
    onClick: async () => {
      const doRenew = async () => {
        await plugin.renewRoomId(room.id);
        rerender();
      };
      if (room.sharingActive) {
        new ConfirmModal(plugin.app, {
          title: "Renew this room's ID?",
          body: "This generates a new room code and deletes the old one's files from the server (your local files are safe). Anyone using the old code will be disconnected and must be given the new one.",
          confirmText: 'Renew ID',
          warning: true,
          onConfirm: doRenew,
        }).open();
      } else {
        await doRenew();
      }
    },
  });

  actions.push({
    label: 'Sync Now',
    disabled: !room.sharingActive,
    ...(room.sharingActive ? {} : { tooltip: 'Start sharing first.' }),
    onClick: async () => {
      await syncRoom(plugin, room.id, false);
    },
  });

  actions.push({
    label: 'Reconstruct Server State',
    disabled: !room.sharingActive,
    ...(room.sharingActive ? {} : { tooltip: 'Start sharing first.' }),
    onClick: async () => {
      await plugin.reconstructDatabase(room.id);
      rerender();
    },
  });

  actions.push({
    label: 'Delete',
    warning: true,
    disabled: room.sharingActive,
    ...(room.sharingActive ? { tooltip: 'Stop sharing first.' } : {}),
    onClick: async () => {
      try {
        await plugin.deleteHostedRoom(room.id);
        rerender();
      } catch (e: any) {
        new Notice(e.message || String(e));
      }
    },
  });

  return actions;
}
