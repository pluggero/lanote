import { debounce, Notice, Setting } from 'obsidian';
import type LANotePlugin from '../main';

export function renderServerConnectionSection(containerEl: HTMLElement, plugin: LANotePlugin): void {
  containerEl.createEl('h3', { cls: 'lanote-section-header', text: 'Server Connection' });

  const serverHint = containerEl.createDiv({ cls: 'lanote-banner' });
  serverHint.createEl('strong', { text: 'The server is started separately, via Docker.' });
  serverHint.createEl('br');
  serverHint.appendText('Run ');
  serverHint.createEl('code', { text: 'docker compose up -d' });
  serverHint.appendText(" from the repo (see README) on whichever machine should host it, then point every device at its address below. Connecting from another device on the same network? Find that machine's local IP (e.g. with ");
  serverHint.createEl('code', { text: 'ip addr' });
  serverHint.appendText(' or ');
  serverHint.createEl('code', { text: 'ipconfig' });
  serverHint.appendText('), e.g. ');
  serverHint.createEl('code', { text: 'ws://192.168.1.12:4444' });
  serverHint.appendText('.');

  // Debounced rather than reinitializing every room on each keystroke --
  // reinitializeAllRooms() tears down and rebuilds every active collab
  // session, which is disruptive to do on every character typed.
  const debouncedReinit = debounce(() => { plugin.reinitializeAllRooms(); }, 800, true);

  new Setting(containerEl)
    .setName('Server Connection URL')
    .setDesc('The relay server all your devices connect to (see the hint above for how to start it). Default: ws://localhost:4444, if the server is running on this same machine. The server never sees plaintext, so this connection does not need to be encrypted itself.')
    .addText(text => text
      .setPlaceholder('ws://localhost:4444')
      .setValue(plugin.settings.signalingUrl)
      .onChange(async (val) => {
        plugin.settings.signalingUrl = val;
        debouncedReinit();
      }));

  new Setting(containerEl)
    .setName('Reconnect All Files')
    .setDesc('Force a reconnection to the server with current settings.')
    .addButton(btn => btn
      .setButtonText('Reconnect')
      .onClick(() => {
        plugin.reconnectAll();
        new Notice('Reconnecting to server...');
      }));
}
