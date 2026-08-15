import type LANotePlugin from '../main';
import { PerRoomSettingsStore } from './perRoomSettingsStore';

/**
 * Per-room, per-device record of the mtime this device last confirmed was
 * in sync with the server for a wireRelPath -- lets a file type tell "this
 * peer hasn't touched the file since last sync" apart from "diverged" (a
 * raw mtime comparison can't). Which types consult it is decided by
 * filetypes/syncBaseline.ts's needsSyncBaseline, not this class. Thin
 * PerRoomSettingsStore instantiation over `plugin.settings.syncBaselines`.
 */
export class SyncBaselineStore extends PerRoomSettingsStore<number> {
  constructor(plugin: LANotePlugin, roomId: string) {
    super(plugin, roomId, () => plugin.settings.syncBaselines);
  }
}
