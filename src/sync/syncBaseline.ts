import type LANotePlugin from '../main';
import { saveSettings } from '../lib/settingsStore';

/**
 * Per-room, per-device record of the mtime this device last confirmed was
 * in sync with the server for a given wireRelPath -- the three-way merge
 * base a file type needs to tell "this peer hasn't touched the file since
 * its last sync" apart from "this peer diverged," which a raw local-vs-
 * remote mtime comparison can't do on its own (both look like "mtimes
 * differ"). Format-agnostic: which file types actually consult this before
 * treating a mismatch as a conflict is a per-type policy decision made by
 * their own filetypes/ module (e.g. filetypes/excalidraw/syncBaseline.ts),
 * not by this class.
 *
 * Backed by the plugin's own settings storage (loadData/saveData), like
 * everything else in LANoteSettings.
 */
export class SyncBaselineStore {
  private dirty = false;

  constructor(private plugin: LANotePlugin, private roomId: string) {}

  private roomMap(): Record<string, number> {
    this.plugin.settings.syncBaselines[this.roomId] ??= {};
    return this.plugin.settings.syncBaselines[this.roomId] as Record<string, number>;
  }

  /** The mtime this device last confirmed was in sync for wireRelPath, or undefined if never recorded. */
  get(wireRelPath: string): number | undefined {
    return this.roomMap()[wireRelPath];
  }

  set(wireRelPath: string, mtime: number): void {
    this.roomMap()[wireRelPath] = mtime;
    this.dirty = true;
  }

  /** Persists any pending set() calls since the last flush. No-op if nothing changed, so a quiet sync pass doesn't touch disk. */
  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    await saveSettings(this.plugin);
  }
}
