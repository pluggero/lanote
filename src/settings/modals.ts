import { App, Modal, Notice, Setting, TextComponent, TFolder, FuzzySuggestModal } from 'obsidian';
import type LANotePlugin from '../main';

// ─────────────────────────────────────────────────────────────────
// FOLDER PICKER
// ─────────────────────────────────────────────────────────────────

export class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
  constructor(app: App, private onChoose: (folder: TFolder) => void) {
    super(app);
    this.setPlaceholder('Choose a folder to share...');
  }

  getItems(): TFolder[] {
    return this.app.vault.getAllLoadedFiles()
      .filter((f): f is TFolder => f instanceof TFolder && !f.isRoot());
  }

  getItemText(folder: TFolder): string {
    return folder.path;
  }

  onChooseItem(folder: TFolder): void {
    this.onChoose(folder);
  }
}

// ─────────────────────────────────────────────────────────────────
// CREATE A ROOM
// ─────────────────────────────────────────────────────────────────

export class NewRoomModal extends Modal {
  private folder = '';

  constructor(app: App, private onCreate: (folder: string) => void | Promise<void>) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'New Room' });
    contentEl.createEl('p', {
      text: "Choose (or type a new name for) the folder you want to share. You'll be able to start and stop sharing it, and to renew its room ID, from the room list.",
      cls: 'lanote-modal-desc',
    });

    let folderInput: TextComponent;
    new Setting(contentEl)
      .setName('Folder to Share')
      .setDesc("Created automatically if it doesn't already exist.")
      .addText(text => {
        folderInput = text;
        text.setPlaceholder('e.g. Team Notes')
          .onChange(val => { this.folder = val.trim(); });
      })
      .addExtraButton(btn => btn
        .setIcon('folder')
        .setTooltip('Browse existing folders')
        .onClick(() => {
          new FolderSuggestModal(this.app, (folder) => {
            this.folder = folder.path;
            folderInput.setValue(folder.path);
          }).open();
        }));

    new Setting(contentEl)
      .addButton(btn => btn
        .setButtonText('Create Room')
        .setCta()
        .onClick(async () => {
          if (!this.folder) {
            new Notice('Choose or type a folder first.');
            return;
          }
          btn.setDisabled(true).setButtonText('Creating...');
          try {
            await this.onCreate(this.folder);
            this.close();
          } finally {
            btn.setDisabled(false).setButtonText('Create Room');
          }
        }));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

// ─────────────────────────────────────────────────────────────────
// JOIN A ROOM
// ─────────────────────────────────────────────────────────────────

export class JoinRoomModal extends Modal {
  private roomCode = '';
  private destFolder = '';

  constructor(app: App, private plugin: LANotePlugin, private onDone: () => void) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Join a Room' });
    contentEl.createEl('p', {
      text: 'Enter the room code you were given and choose (or type a new name for) a folder to receive its contents.',
      cls: 'lanote-modal-desc',
    });

    new Setting(contentEl)
      .setName('Room Code')
      .addText(text => text
        .setPlaceholder('e.g. K7QM-9XJ2-4RTN-VB3W-XHNC-7SYA')
        .onChange(val => { this.roomCode = val.trim(); }));

    let destInput: TextComponent;
    new Setting(contentEl)
      .setName('Destination Folder')
      .setDesc("Created automatically if it doesn't already exist.")
      .addText(text => {
        destInput = text;
        text.setPlaceholder('e.g. Team Notes')
          .onChange(val => { this.destFolder = val.trim(); });
      })
      .addExtraButton(btn => btn
        .setIcon('folder')
        .setTooltip('Browse existing folders')
        .onClick(() => {
          new FolderSuggestModal(this.app, (folder) => {
            this.destFolder = folder.path;
            destInput.setValue(folder.path);
          }).open();
        }));

    new Setting(contentEl)
      .addButton(btn => btn
        .setButtonText('Join')
        .setCta()
        .onClick(async () => {
          btn.setDisabled(true).setButtonText('Joining...');
          try {
            await this.join();
          } finally {
            btn.setDisabled(false).setButtonText('Join');
          }
        }));
  }

  private async join(): Promise<void> {
    if (!this.roomCode) {
      new Notice('Enter a room code first.');
      return;
    }
    if (!this.destFolder) {
      new Notice('Choose or type a destination folder first.');
      return;
    }

    let room;
    try {
      room = await this.plugin.joinRoom(this.roomCode, this.destFolder);
    } catch (e: any) {
      new Notice(e.message || String(e));
      return;
    }

    this.close();
    this.onDone();

    const runtime = this.plugin.roomRuntimes.get(room.id);
    if (!runtime) {
      new Notice('Something went wrong setting up the room.');
      return;
    }

    // Best-effort signal only: TOFU auth means a mistyped code silently
    // claims its own new, empty room rather than failing outright, so an
    // empty count can't be told apart from a legitimately new room.
    try {
      const fileCount = await runtime.configSyncEngine.getRoomFileCount();
      if (fileCount === 0) {
        new Notice('Joined — this looks like a new/empty room. If you expected existing files, double-check the room code.', 8000);
      }
    } catch (e) {
      new Notice('Joined, but could not reach the server to check its contents. Check the Server Connection URL.', 8000);
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

// ─────────────────────────────────────────────────────────────────
// CONFIRM
// ─────────────────────────────────────────────────────────────────

export interface ConfirmModalOptions {
  title: string;
  body: string;
  confirmText: string;
  warning?: boolean;
  onConfirm: () => void | Promise<void>;
}

export class ConfirmModal extends Modal {
  constructor(app: App, private opts: ConfirmModalOptions) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: this.opts.title });
    contentEl.createEl('p', { text: this.opts.body, cls: 'lanote-modal-desc' });

    new Setting(contentEl)
      .addButton(btn => btn
        .setButtonText('Cancel')
        .onClick(() => this.close()))
      .addButton(btn => {
        btn.setButtonText(this.opts.confirmText);
        if (this.opts.warning) btn.setWarning(); else btn.setCta();
        btn.onClick(async () => {
          this.close();
          await this.opts.onConfirm();
        });
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
