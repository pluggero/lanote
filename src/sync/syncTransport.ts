import { requestUrl } from 'obsidian';
import { type RoomKeys, encryptBytes, decryptBytes, makeAAD, base64UrlEncode } from '../crypto';
import { normalizeServerUrl } from '../serverUrl';
import type { FileManifest } from '../syncPaths';

/**
 * Thin encrypted REST client for the relay server: builds authenticated
 * request URLs and headers, and encrypts/decrypts request and response
 * bodies. Knows nothing about local vault state or conflict resolution --
 * that's ConfigSyncEngine's job.
 */
export class SyncTransport {
  constructor(
    private serverUrl: string,
    private roomKeys: RoomKeys,
  ) {}

  getApiUrl(endpoint: string, extraParams: Record<string, string> = {}): string {
    const cleaned = normalizeServerUrl(this.serverUrl);
    const httpUrl = cleaned.replace(/^ws/i, 'http');
    const params = new URLSearchParams({ room: this.roomKeys.roomId, ...extraParams });
    return `${httpUrl}/api${endpoint}?${params.toString()}`;
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${base64UrlEncode(this.roomKeys.authToken)}` };
  }

  async getRemoteManifest(): Promise<FileManifest> {
    const url = this.getApiUrl('/manifest');
    const res = await requestUrl({ url, method: 'GET', headers: this.authHeaders() });
    if (res.status !== 200) throw new Error(`Server returned HTTP ${res.status}: ${res.text || 'No response body'}`);
    return res.json as FileManifest;
  }

  async getRoomFileCount(): Promise<number> {
    return Object.keys(await this.getRemoteManifest()).length;
  }

  async reconstructRoom(): Promise<void> {
    const url = this.getApiUrl('/reconstruct-db');
    const res = await requestUrl({ url, method: 'POST', headers: this.authHeaders() });
    if (res.status !== 200) throw new Error(`Server returned HTTP ${res.status}: ${res.text || 'No response body'}`);
  }

  async deleteRoomOnServer(): Promise<void> {
    const url = this.getApiUrl('/room');
    const res = await requestUrl({ url, method: 'DELETE', headers: this.authHeaders() });
    if (res.status !== 200) throw new Error(`Room deletion failed: HTTP ${res.status} ${res.text || ''}`);
  }

  async uploadFile(wireRelPath: string, data: ArrayBuffer, mtime: number): Promise<void> {
    const envelope = await encryptBytes(this.roomKeys.encKey, data, makeAAD(this.roomKeys.roomId, 'file'));
    const url = this.getApiUrl('/upload', { path: wireRelPath, mtime: String(mtime) });
    const res = await requestUrl({ url, method: 'POST', headers: this.authHeaders(), body: envelope });
    if (res.status !== 200) throw new Error(`Upload failed: ${res.text}`);
  }

  async downloadFile(wireRelPath: string): Promise<ArrayBuffer> {
    const url = this.getApiUrl('/download', { path: wireRelPath });
    const res = await requestUrl({ url, method: 'GET', headers: this.authHeaders() });
    if (res.status !== 200) throw new Error('Download failed');
    return decryptBytes(this.roomKeys.encKey, res.arrayBuffer, makeAAD(this.roomKeys.roomId, 'file'));
  }

  /** Fetches and decrypts the room's latest live-collab CRDT snapshot, or null if none exists yet. */
  async getRoomStateSnapshot(wireRelPath: string): Promise<Uint8Array<ArrayBuffer> | null> {
    const url = this.getApiUrl('/room-state', { path: wireRelPath });
    const res = await requestUrl({ url, method: 'GET', headers: this.authHeaders() });
    if (res.status !== 200 || res.arrayBuffer.byteLength === 0) return null;
    const decrypted = await decryptBytes(this.roomKeys.encKey, res.arrayBuffer, makeAAD(this.roomKeys.roomId, 'room-state'));
    return new Uint8Array(decrypted);
  }

  /** Encrypts and pushes a live-collab CRDT snapshot (Y.encodeStateAsUpdate output) for other devices to hydrate from. */
  async putRoomStateSnapshot(wireRelPath: string, update: Uint8Array): Promise<void> {
    const envelope = await encryptBytes(this.roomKeys.encKey, update.buffer as ArrayBuffer, makeAAD(this.roomKeys.roomId, 'room-state'));
    const url = this.getApiUrl('/room-state', { path: wireRelPath });
    const res = await requestUrl({ url, method: 'POST', headers: this.authHeaders(), body: envelope });
    if (res.status !== 200) throw new Error(`Snapshot upload failed: ${res.text}`);
  }

  async deleteRemoteFile(wireRelPath: string, deletedAtMs: number): Promise<void> {
    const url = this.getApiUrl('/delete', { path: wireRelPath, mtime: String(deletedAtMs) });
    await requestUrl({ url, method: 'DELETE', headers: this.authHeaders() });
  }

  /** Fetches the room's deletion records: wire-relative path -> the deleting client's Date.now() at delete time. */
  async getRemoteTombstones(): Promise<Record<string, number>> {
    const url = this.getApiUrl('/tombstones');
    const res = await requestUrl({ url, method: 'GET', headers: this.authHeaders() });
    if (res.status !== 200) throw new Error(`Server returned HTTP ${res.status}: ${res.text || 'No response body'}`);
    return res.json as Record<string, number>;
  }
}
