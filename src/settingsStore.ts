import type LANotePlugin from './main';
import { DEFAULT_SYNC_INTERVAL_SECONDS } from './sync/syncInterval';

// A room this device hosts: its files live locally, and are pushed to the
// server while `sharingActive`. `id` is a stable local list id, distinct from
// the crypto-derived roomId (which changes on renew).
export interface HostedRoom {
  id: string;
  roomSecret: string;
  sharedFolder: string;
  sharingActive: boolean;
  createdAt: number;
  updatedAt: number;
}

// A room this device joined: its files were pulled from someone else's shared folder.
export interface JoinedRoom {
  id: string;
  roomSecret: string;
  sharedFolder: string;
  joinedAt: number;
}

export interface LANoteSettings {
  nickname: string;
  cursorColor: string;
  signalingUrl: string;
  // Loaded straight from data.json, so not guaranteed to be in range (e.g. hand-edited) -- always pass through clampSyncIntervalSeconds (sync/syncInterval.ts) before use.
  syncIntervalSeconds: number;
  hostedRooms: HostedRoom[];
  joinedRooms: JoinedRoom[];
  // Bumped on breaking settings-shape changes so loadSettings() can migrate
  // old data.json files forward. 2 = multi-room hostedRooms/joinedRooms model.
  settingsSchemaVersion: number;
}

export const DEFAULT_SETTINGS: LANoteSettings = {
  nickname: 'Me',
  cursorColor: '#6366f1',
  signalingUrl: 'ws://localhost:4444',
  syncIntervalSeconds: DEFAULT_SYNC_INTERVAL_SECONDS,
  hostedRooms: [],
  joinedRooms: [],
  settingsSchemaVersion: 2,
}

export async function loadSettings(plugin: LANotePlugin): Promise<void> {
  const raw = await plugin.loadData();
  // v1 -> v2 migration: the old single-room shape (scalar sharedFolder +
  // roomSecret) becomes one hosted, actively-sharing room. Treated as
  // hosted rather than joined because the old UI already exposed full
  // owner-level controls (renew/reconstruct/etc.) for that one room
  // regardless of whether the user was actually hosting or just joined --
  // this preserves all existing functionality either way.
  if (raw && !raw.settingsSchemaVersion && (raw.sharedFolder || raw.roomSecret)) {
    const now = Date.now();
    raw.hostedRooms = [{
      id: crypto.randomUUID(),
      roomSecret: raw.roomSecret,
      sharedFolder: raw.sharedFolder,
      sharingActive: true,
      createdAt: now,
      updatedAt: now,
    }];
    raw.joinedRooms = [];
    delete raw.sharedFolder;
    delete raw.roomSecret;
    raw.settingsSchemaVersion = 2;
  }
  plugin.settings = Object.assign({}, DEFAULT_SETTINGS, raw);
  plugin.settings.hostedRooms ??= [];
  plugin.settings.joinedRooms ??= [];
}

export async function saveSettings(plugin: LANotePlugin): Promise<void> {
  await plugin.saveData(plugin.settings);
}
