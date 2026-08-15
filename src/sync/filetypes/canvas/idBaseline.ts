import type LANotePlugin from '../../../main';
import { PerRoomSettingsStore } from '../../perRoomSettingsStore';
import { parseCanvas, type CanvasData } from './codec';

export interface CanvasKnownIds {
  nodeIds: string[];
  edgeIds: string[];
}

/**
 * Per-room, per-device record of the node/edge ids this device has last
 * confirmed as merged for a canvas wireRelPath -- reconcileCanvasEntries's
 * `knownIds` (reconcileElements.ts) needs this to tell a real delete apart
 * from a device that's merely behind. Thin PerRoomSettingsStore instantiation
 * over `plugin.settings.canvasIdBaselines`.
 */
export class CanvasIdBaselineStore extends PerRoomSettingsStore<CanvasKnownIds> {
  constructor(plugin: LANotePlugin, roomId: string) {
    super(plugin, roomId, () => plugin.settings.canvasIdBaselines);
  }
}

/** The known-id set implied by a merged CanvasData: every id currently present in its `nodes`/`edges` arrays. */
export function knownIdsOf(data: CanvasData): CanvasKnownIds {
  return {
    nodeIds: data.nodes.map(n => n.id),
    edgeIds: data.edges.map(e => e.id),
  };
}

/**
 * Parses `data` as a canvas file and records its known ids into `store` for
 * `wireRelPath`. Used at configSync.ts's non-conflict sync paths (upload,
 * download, contents-match), where resolveCanvasConflict -- which records
 * ids itself -- never runs. No-ops silently on unparseable data.
 */
export function recordKnownIdsFromBytes(store: CanvasIdBaselineStore, wireRelPath: string, data: ArrayBuffer): void {
  const parsed = parseCanvas(new TextDecoder('utf-8').decode(data));
  if (!parsed) return;
  store.set(wireRelPath, knownIdsOf(parsed));
}
