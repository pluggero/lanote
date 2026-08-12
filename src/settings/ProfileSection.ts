import { Setting } from 'obsidian';
import type LANotePlugin from '../main';

export function renderProfileSection(containerEl: HTMLElement, plugin: LANotePlugin): void {
  containerEl.createEl('h3', { cls: 'lanote-section-header', text: 'Your Profile' });

  new Setting(containerEl)
    .setName('Collaborator Nickname')
    .setDesc('The name shown next to your cursor on other devices.')
    .addText(text => text
      .setPlaceholder('Anonymous Editor')
      .setValue(plugin.settings.nickname)
      .onChange(async (val) => {
        plugin.settings.nickname = val || 'Anonymous';
        await plugin.saveSettings();
      }));

  new Setting(containerEl)
    .setName('Cursor Color')
    .setDesc('Your cursor and selection highlight color.')
    .addColorPicker(color => color
      .setValue(plugin.settings.cursorColor)
      .onChange(async (val) => {
        plugin.settings.cursorColor = val;
        await plugin.saveSettings();
      }));
}
