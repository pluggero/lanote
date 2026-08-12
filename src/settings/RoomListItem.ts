import { ButtonComponent, ExtraButtonComponent, Notice } from 'obsidian';
import type { RoomPeer } from './roomPeers';

export type BadgeVariant = 'sharing' | 'stopped' | 'connected' | 'connecting' | 'disconnected';

export interface RoomListItemAction {
  label: string;
  warning?: boolean;
  disabled?: boolean;
  tooltip?: string;
  onClick: () => void | Promise<void>;
}

export interface RoomListItemConfig {
  containerEl: HTMLElement;
  roomIdLabel: string;
  folderPath: string;
  statusBadge: { text: string; variant: BadgeVariant };
  peers: RoomPeer[];
  actions: RoomListItemAction[];
}

export interface RoomListItemHandle {
  el: HTMLElement;
  updatePeers: (peers: RoomPeer[]) => void;
}

/** Shared list-item renderer used by both the Create Room and Join Room sections. */
export function renderRoomListItem(cfg: RoomListItemConfig): RoomListItemHandle {
  const { containerEl, roomIdLabel, folderPath, statusBadge, actions } = cfg;

  const item = containerEl.createDiv({ cls: 'lanote-room-item' });

  const header = item.createDiv({ cls: 'lanote-room-item-header' });
  const left = header.createDiv();
  left.createDiv({ cls: 'lanote-room-folder', text: folderPath });
  const codeRow = left.createDiv({ cls: 'lanote-room-code-row' });
  codeRow.createSpan({ cls: 'lanote-room-code', text: roomIdLabel });
  new ExtraButtonComponent(codeRow)
    .setIcon('copy')
    .setTooltip('Copy room code')
    .onClick(() => {
      navigator.clipboard.writeText(roomIdLabel);
      new Notice('Room code copied to clipboard.');
    });

  header.createSpan({ cls: `lanote-badge lanote-badge-${statusBadge.variant}`, text: statusBadge.text });

  const peersEl = item.createDiv({ cls: 'lanote-peer-list' });
  const updatePeers = (peers: RoomPeer[]) => {
    peersEl.empty();
    if (peers.length === 0) {
      peersEl.createSpan({ cls: 'lanote-peer-empty', text: 'No one else here yet' });
      return;
    }
    peersEl.createSpan({ text: `${peers.length} peer${peers.length === 1 ? '' : 's'} online (viewing a shared file)` });
    for (const peer of peers) {
      const dot = peersEl.createSpan({ cls: 'lanote-peer-dot', attr: { title: peer.name } });
      dot.style.backgroundColor = peer.color;
    }
  };
  updatePeers(cfg.peers);

  const actionsEl = item.createDiv({ cls: 'lanote-room-actions' });
  for (const action of actions) {
    const btn = new ButtonComponent(actionsEl)
      .setButtonText(action.label)
      .setDisabled(!!action.disabled)
      .onClick(() => action.onClick());
    if (action.warning) btn.setWarning();
    if (action.tooltip) btn.setTooltip(action.tooltip);
  }

  return { el: item, updatePeers };
}
