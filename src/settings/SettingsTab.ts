import { App, PluginSettingTab } from 'obsidian';
import type LANotePlugin from '../main';
import type { HostedRoom, JoinedRoom } from '../settingsStore';
import { renderProfileSection } from './ProfileSection';
import { renderServerConnectionSection } from './ServerConnectionSection';
import { renderCreateRoomSection } from './CreateRoomSection';
import { renderJoinRoomSection } from './JoinRoomSection';
import { getRoomPeers } from './roomPeers';
import type { RoomListItemHandle } from './RoomListItem';

// Not room-wide presence, just a periodic re-read of per-open-file Yjs
// awareness (see roomPeers.ts) -- 3s balances responsiveness against DOM churn.
const PEER_REFRESH_INTERVAL_MS = 3000;

export class LANoteSettingTab extends PluginSettingTab {
  plugin: LANotePlugin;
  private peerRefreshInterval: ReturnType<typeof setInterval> | null = null;
  private hostedHandles: { room: HostedRoom; handle: RoomListItemHandle }[] = [];
  private joinedHandles: { room: JoinedRoom; handle: RoomListItemHandle }[] = [];

  constructor(app: App, plugin: LANotePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const header = containerEl.createDiv();
    header.createEl('h2', { text: 'LANote Settings' });
    header.createEl('p', {
      cls: 'lanote-subtitle',
      text: 'Real-time collaborative editing over your local network, with a zero-knowledge server.',
    });

    const hasAnyRoom = this.plugin.settings.hostedRooms.length > 0 || this.plugin.settings.joinedRooms.length > 0;
    if (!hasAnyRoom) {
      const banner = containerEl.createDiv({ cls: 'lanote-banner' });
      banner.createEl('strong', { text: 'Not set up yet. ' });
      banner.createSpan({ text: 'Create a room below to share a folder, or join one using a room code someone gave you.' });
    }

    renderProfileSection(containerEl, this.plugin);
    renderServerConnectionSection(containerEl, this.plugin);

    const rerender = () => this.display();

    const hostedItemHandles = renderCreateRoomSection(containerEl, this.plugin, rerender);
    this.hostedHandles = this.plugin.settings.hostedRooms
      .map((room, i) => ({ room, handle: hostedItemHandles[i] }))
      .filter((x): x is { room: HostedRoom; handle: RoomListItemHandle } => !!x.handle);

    const joinedItemHandles = renderJoinRoomSection(containerEl, this.plugin, rerender);
    this.joinedHandles = this.plugin.settings.joinedRooms
      .map((room, i) => ({ room, handle: joinedItemHandles[i] }))
      .filter((x): x is { room: JoinedRoom; handle: RoomListItemHandle } => !!x.handle);

    this.startPeerRefresh();
  }

  hide(): void {
    this.stopPeerRefresh();
  }

  private startPeerRefresh(): void {
    this.stopPeerRefresh();
    this.peerRefreshInterval = setInterval(() => {
      for (const { room, handle } of this.hostedHandles) handle.updatePeers(getRoomPeers(this.plugin, room));
      for (const { room, handle } of this.joinedHandles) handle.updatePeers(getRoomPeers(this.plugin, room));
    }, PEER_REFRESH_INTERVAL_MS);
  }

  private stopPeerRefresh(): void {
    if (this.peerRefreshInterval) {
      clearInterval(this.peerRefreshInterval);
      this.peerRefreshInterval = null;
    }
  }
}
