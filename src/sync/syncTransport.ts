import { Notice, requestUrl } from 'obsidian';
import { type RoomKeys, encryptBytes, decryptBytes, encryptFileName, decryptFileName, derivePathToken, makeAAD, base64UrlEncode } from '../lib/crypto';
import { normalizeServerUrl } from '../lib/serverUrl';
import type { FileManifest } from '../lib/syncPaths';

const ENC_NAME_HEADER = 'X-LANote-Enc-Name';

interface RawManifest {
  [token: string]: { encName?: string; size: number; mtime: number };
}

/**
 * Thin encrypted REST client for the relay server: builds authenticated
 * request URLs and headers, and encrypts/decrypts request and response
 * bodies -- including translating between wire-relative paths (used by
 * callers) and the opaque per-file tokens/encrypted names the server
 * actually sees. Knows nothing about local vault state or conflict
 * resolution -- that's ConfigSyncEngine's job.
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

  private pathToken(wireRelPath: string): Promise<string> {
    return derivePathToken(this.roomKeys.pathKey, wireRelPath);
  }

  /** Fetches the manifest and decrypts each entry's name back to a wire-relative path, keyed the same way the pre-encryption manifest was. Entries with a missing or undecryptable name are skipped and surfaced via Notice, since a failed decrypt can mean tampering, not just corruption. */
  async getRemoteManifest(): Promise<FileManifest> {
    const url = this.getApiUrl('/manifest');
    const res = await requestUrl({ url, method: 'GET', headers: this.authHeaders() });
    if (res.status !== 200) throw new Error(`Server returned HTTP ${res.status}: ${res.text || 'No response body'}`);
    const raw = res.json as RawManifest;
    const manifest: FileManifest = {};
    for (const [token, entry] of Object.entries(raw)) {
      if (!entry.encName) {
        console.warn(`[LANote] Manifest entry ${token} has no name; skipping`);
        continue;
      }
      try {
        const wireRelPath = await decryptFileName(this.roomKeys.encKey, this.roomKeys.roomId, token, entry.encName);
        manifest[wireRelPath] = { size: entry.size, mtime: entry.mtime };
      } catch (e) {
        console.error(`[LANote] Failed to decrypt name for manifest entry ${token}:`, e);
        new Notice(`LANote: a file's name could not be decrypted and was skipped (possible tampering or a stale room key).`, 8000);
      }
    }
    return manifest;
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
    const token = await this.pathToken(wireRelPath);
    const [envelope, encName] = await Promise.all([
      encryptBytes(this.roomKeys.encKey, data, makeAAD(this.roomKeys.roomId, 'file', token)),
      encryptFileName(this.roomKeys.encKey, this.roomKeys.roomId, token, wireRelPath),
    ]);
    const url = this.getApiUrl('/upload', { path: token, mtime: String(mtime) });
    const res = await requestUrl({ url, method: 'POST', headers: { ...this.authHeaders(), [ENC_NAME_HEADER]: encName }, body: envelope });
    if (res.status !== 200) throw new Error(`Upload failed: ${res.text}`);
  }

  async downloadFile(wireRelPath: string): Promise<ArrayBuffer> {
    const token = await this.pathToken(wireRelPath);
    const url = this.getApiUrl('/download', { path: token });
    const res = await requestUrl({ url, method: 'GET', headers: this.authHeaders() });
    if (res.status !== 200) throw new Error('Download failed');
    return decryptBytes(this.roomKeys.encKey, res.arrayBuffer, makeAAD(this.roomKeys.roomId, 'file', token));
  }

  /** Fetches and decrypts the room's latest live-collab CRDT snapshot, or null if none exists yet. */
  async getRoomStateSnapshot(wireRelPath: string): Promise<Uint8Array<ArrayBuffer> | null> {
    const token = await this.pathToken(wireRelPath);
    const url = this.getApiUrl('/room-state', { path: token });
    const res = await requestUrl({ url, method: 'GET', headers: this.authHeaders() });
    if (res.status !== 200 || res.arrayBuffer.byteLength === 0) return null;
    const decrypted = await decryptBytes(this.roomKeys.encKey, res.arrayBuffer, makeAAD(this.roomKeys.roomId, 'room-state', token));
    return new Uint8Array(decrypted);
  }

  /** Encrypts and pushes a live-collab CRDT snapshot (Y.encodeStateAsUpdate output) for other devices to hydrate from. */
  async putRoomStateSnapshot(wireRelPath: string, update: Uint8Array): Promise<void> {
    const token = await this.pathToken(wireRelPath);
    const envelope = await encryptBytes(this.roomKeys.encKey, update.buffer as ArrayBuffer, makeAAD(this.roomKeys.roomId, 'room-state', token));
    const url = this.getApiUrl('/room-state', { path: token });
    const res = await requestUrl({ url, method: 'POST', headers: this.authHeaders(), body: envelope });
    if (res.status !== 200) throw new Error(`Snapshot upload failed: ${res.text}`);
  }

  async deleteRemoteFile(wireRelPath: string, deletedAtMs: number): Promise<void> {
    const token = await this.pathToken(wireRelPath);
    const url = this.getApiUrl('/delete', { path: token, mtime: String(deletedAtMs) });
    await requestUrl({ url, method: 'DELETE', headers: this.authHeaders() });
  }

  /** Fetches the room's deletion records, keyed by path token (not a readable path -- callers that need to check a specific wireRelPath must derive its token themselves). */
  async getRemoteTombstones(): Promise<Record<string, number>> {
    const url = this.getApiUrl('/tombstones');
    const res = await requestUrl({ url, method: 'GET', headers: this.authHeaders() });
    if (res.status !== 200) throw new Error(`Server returned HTTP ${res.status}: ${res.text || 'No response body'}`);
    return res.json as Record<string, number>;
  }
}
