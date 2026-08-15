import type LANotePlugin from '../main';
import { saveSettings } from '../lib/settingsStore';

/**
 * Generic per-room, per-device settings-backed key-value store, used by
 * SyncBaselineStore and CanvasIdBaselineStore. Each subclass supplies a
 * `readMap` accessor for its own `Record<roomId, Record<key, V>>` slice of
 * LANoteSettings; this base handles dirty-flag/roomMap/get-set-flush.
 */
export class PerRoomSettingsStore<V> {
  private dirty = false;

  constructor(
    private plugin: LANotePlugin,
    private roomId: string,
    private readMap: () => Record<string, Record<string, V>>
  ) {}

  private roomMap(): Record<string, V> {
    const map = this.readMap();
    map[this.roomId] ??= {};
    return map[this.roomId] as Record<string, V>;
  }

  /** The value this device last recorded for `key`, or undefined if never set. */
  get(key: string): V | undefined {
    return this.roomMap()[key];
  }

  set(key: string, value: V): void {
    this.roomMap()[key] = value;
    this.dirty = true;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  /** Clears the dirty flag without saving -- flushStores() below batches this across stores before one shared save. */
  markFlushed(): void {
    this.dirty = false;
  }

  /** Persists pending set() calls via a dedicated save; no-op if unchanged. For flushing alongside other stores, use flushStores() instead. */
  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.markFlushed();
    await saveSettings(this.plugin);
  }
}

/** Flushes multiple stores through one shared saveSettings call instead of one per dirty store -- they all mutate the same plugin.settings object in place. */
export async function flushStores(plugin: LANotePlugin, stores: PerRoomSettingsStore<any>[]): Promise<void> {
  const anyDirty = stores.some(s => s.isDirty);
  for (const s of stores) s.markFlushed();
  if (anyDirty) await saveSettings(plugin);
}
