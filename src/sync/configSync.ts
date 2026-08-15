import { App, Notice } from 'obsidian';
import type LANotePlugin from '../main';
import { type RoomKeys, derivePathToken } from '../lib/crypto';
import { ensureParentDirsExist, writeBinaryFile, deleteLocalFile } from '../lib/vaultFs';
import { toWireRelPath, toVaultRelPath, shouldIgnore } from '../lib/syncPaths';
import { SyncTransport } from './syncTransport';
import { resolveByLatestMtime } from './mtimeWins';
import { detectFileType } from './filetypes/detectFileType';
import { resolveMarkdownConflict } from './filetypes/markdown/merge';
import { resolveJsonConflict } from './filetypes/json/merge';
import { resolveExcalidrawConflict } from './filetypes/excalidraw/merge';
import { resolveCanvasConflict } from './filetypes/canvas/merge';
import { CanvasIdBaselineStore, recordKnownIdsFromBytes } from './filetypes/canvas/idBaseline';
import { needsSyncBaseline } from './filetypes/syncBaseline';
import { SyncBaselineStore } from './syncBaseline';
import { flushStores } from './perRoomSettingsStore';

export class ConfigSyncEngine {
  // Instance-level (not static): with multi-room support, each room gets its
  // own engine instance, and one room's sync shouldn't block another's.
  private isSyncing = false;
  private transport: SyncTransport;
  private app: App;
  private baseline: SyncBaselineStore;
  private canvasIds: CanvasIdBaselineStore;

  constructor(
    private plugin: LANotePlugin,
    public serverUrl: string,
    private roomKeys: RoomKeys,
    // Vault-relative path of the folder being shared ("" means the whole vault).
    // Devices are allowed to store this folder under different local names --
    // everything on the wire uses paths relative to it, never the vault-absolute path.
    public sharedFolder: string,
    roomId: string
  ) {
    this.app = plugin.app;
    this.transport = new SyncTransport(serverUrl, roomKeys);
    this.baseline = new SyncBaselineStore(plugin, roomId);
    this.canvasIds = new CanvasIdBaselineStore(plugin, roomId);
  }

  /**
   * Number of files the server already has for this room. Throws if the
   * server is unreachable, so callers can distinguish "room is empty" from
   * "couldn't check" -- useful as a (best-effort, not authoritative) signal
   * right after joining a room: TOFU auth means a mistyped room code just
   * silently claims its own new, empty room rather than failing outright.
   */
  public async getRoomFileCount(): Promise<number> {
    return this.transport.getRoomFileCount();
  }

  /** Clears this room's server-side CRDT snapshots (not the uploaded files themselves). */
  public async reconstructRoom(): Promise<void> {
    return this.transport.reconstructRoom();
  }

  /** Deletes this room's entire directory on the server -- uploaded files, CRDT snapshots, and auth verifier. Used when sharing is stopped or a room's ID is renewed. */
  public async deleteRoomOnServer(): Promise<void> {
    return this.transport.deleteRoomOnServer();
  }

  public async uploadFile(wireRelPath: string, data: ArrayBuffer, mtime: number): Promise<void> {
    return this.transport.uploadFile(wireRelPath, data, mtime);
  }

  /** Fetches and decrypts the room's latest live-collab CRDT snapshot, or null if none exists yet. */
  public async getRoomStateSnapshot(wireRelPath: string): Promise<Uint8Array<ArrayBuffer> | null> {
    return this.transport.getRoomStateSnapshot(wireRelPath);
  }

  /** Encrypts and pushes a live-collab CRDT snapshot (Y.encodeStateAsUpdate output) for other devices to hydrate from. */
  public async putRoomStateSnapshot(wireRelPath: string, update: Uint8Array): Promise<void> {
    return this.transport.putRoomStateSnapshot(wireRelPath, update);
  }

  public async deleteRemoteFile(vaultRelPath: string) {
    if (shouldIgnore(vaultRelPath)) return;
    try {
      await this.transport.deleteRemoteFile(toWireRelPath(this.sharedFolder, vaultRelPath), Date.now());
    } catch (e) {
      console.warn(`[LANote] Failed to delete remote file ${vaultRelPath}:`, e);
    }
  }

  /** Fetches the room's deletion records, keyed by path token. */
  public async getRemoteTombstones(): Promise<Record<string, number>> {
    return this.transport.getRemoteTombstones();
  }

  /**
   * Performs an incremental, database-free shared-folder configuration and file sync.
   * Compares the local file system manifest with the server manifest, pushing and pulling
   * updates as needed, and resolving conflicts automatically. All file bodies are
   * end-to-end encrypted; the server only ever sees ciphertext, sizes, and relative paths.
   */
  /**
   * @param getActiveLivePaths Wire-relative paths an active live-collab session
   * (activeSyncs) already owns, evaluated fresh on each call since this scan can run for
   * seconds and a file can go live partway through. Skipped only where both a local and
   * remote copy exist: without it, this REST scan and the live session would
   * independently read-modify-write the same room-state key, causing a runaway conflict
   * loop instead of converging. Not applied to local-only uploads -- a live session never
   * touches the file-body manifest, so that upload is the only way a newly created open
   * file ever becomes visible to peers.
   * @param onActiveFileDeletedRemotely Called on a stale-deletion path that's still open locally, before it's deleted.
   */
  public async syncConfig(
    silent: boolean,
    getActiveLivePaths: () => Set<string>,
    onActiveFileDeletedRemotely: (vaultRelPath: string) => void
  ) {
    if (this.isSyncing) {
      if (!silent) new Notice('Sync already in progress...');
      return;
    }
    this.isSyncing = true;
    if (!silent) new Notice('Syncing shared folder...', 2000);

    try {
      const [remoteManifest, tombstones] = await Promise.all([
        this.transport.getRemoteManifest(),
        this.transport.getRemoteTombstones(),
      ]);
      const localFiles: { path: string, stat: any }[] = [];

      const scanRoot = this.sharedFolder.replace(/\/+$/, '');
      const scanDir = async (dir: string) => {
        if (shouldIgnore(dir)) return;

        const list = await this.app.vault.adapter.list(dir);
        for (const file of list.files) {
          if (shouldIgnore(file)) continue;
          const stat = await this.app.vault.adapter.stat(file);
          if (stat) localFiles.push({ path: file, stat });
        }
        for (const folder of list.folders) {
          await scanDir(folder);
        }
      };

      await scanDir(scanRoot);

      // Map local files by wire-relative path (relative to the shared folder) for unified syncing
      const localMap = new Map<string, { path: string, stat: any }>();
      for (const local of localFiles) {
        localMap.set(toWireRelPath(this.sharedFolder, local.path), local);
      }

      // Collect all unique wire-relative paths across local and remote
      const allPaths = new Set<string>([
        ...localMap.keys(),
        ...Object.keys(remoteManifest)
      ]);

      let actionsCount = 0;

      for (const wireRelPath of allPaths) {
        const local = localMap.get(wireRelPath);
        const remote = remoteManifest[wireRelPath];
        const vaultRelPath = toVaultRelPath(this.sharedFolder, wireRelPath);

        if (local && !remote) {
          // A tombstone means a peer already deleted this path; treat this
          // copy as a stale leftover (not a new upload) unless it was
          // touched after the deletion, in which case it's a recreation.
          // Tombstones are keyed by path token (opaque to the server), not
          // wireRelPath, so the token has to be derived to look one up.
          const deletedAt = tombstones[await derivePathToken(this.roomKeys.pathKey, wireRelPath)];
          const isStaleDeletion = deletedAt !== undefined && local.stat.mtime <= deletedAt + 2000;

          if (isStaleDeletion) {
            const isActive = getActiveLivePaths().has(wireRelPath);
            console.log(`[LANote] [diag] syncConfig ${wireRelPath}: stale deletion (deletedAt=${deletedAt}, localMtime=${local.stat.mtime}, active=${isActive}) -> deleting local copy`);
            if (isActive) onActiveFileDeletedRemotely(vaultRelPath);
            await deleteLocalFile(this.app, vaultRelPath);
            actionsCount++;
            continue;
          }

          console.log(`[LANote] [diag] syncConfig ${wireRelPath}: local-only, not a stale deletion (deletedAt=${deletedAt}, localMtime=${local.stat.mtime}) -> uploading`);
          // Not skipped for activeLivePaths: a live session never touches
          // the file-body manifest, so this upload is the only way a
          // just-created, actively open file ever becomes visible to peers.
          const data = await this.app.vault.adapter.readBinary(local.path);
          await this.transport.uploadFile(wireRelPath, data, local.stat.mtime);
          if (needsSyncBaseline(wireRelPath)) this.baseline.set(wireRelPath, local.stat.mtime);
          if (detectFileType(wireRelPath) === 'canvas') recordKnownIdsFromBytes(this.canvasIds, wireRelPath, data);
          actionsCount++;
        } else if (!local && remote) {
          console.log(`[LANote] [diag] syncConfig ${wireRelPath}: remote-only -> downloading`);
          // File exists only remotely -> Download
          await ensureParentDirsExist(this.app, vaultRelPath);
          const data = await this.transport.downloadFile(wireRelPath);
          await writeBinaryFile(this.app, vaultRelPath, data, remote.mtime);
          if (needsSyncBaseline(wireRelPath)) this.baseline.set(wireRelPath, remote.mtime);
          if (detectFileType(wireRelPath) === 'canvas') recordKnownIdsFromBytes(this.canvasIds, wireRelPath, data);
          actionsCount++;
        } else if (local && remote) {
          if (getActiveLivePaths().has(wireRelPath)) continue;

          // File exists in both -> Check for modification differences
          const timeDiff = Math.abs(local.stat.mtime - remote.mtime);

          if (timeDiff > 2000) {
            // needsSyncBaseline(wireRelPath): fast-forward instead of
            // merging when this device's baseline shows one side is
            // unchanged since its last confirmed sync. Requires a baseline
            // already recorded for this exact path; otherwise falls
            // through to full conflict resolution below.
            if (needsSyncBaseline(wireRelPath)) {
              const baselineMtime = this.baseline.get(wireRelPath);
              if (baselineMtime !== undefined && local.stat.mtime === baselineMtime) {
                console.log(`[LANote] [diag] syncConfig ${wireRelPath}: local unchanged since last sync -> fast-forward download`);
                await ensureParentDirsExist(this.app, vaultRelPath);
                const data = await this.transport.downloadFile(wireRelPath);
                await writeBinaryFile(this.app, vaultRelPath, data, remote.mtime);
                this.baseline.set(wireRelPath, remote.mtime);
                actionsCount++;
                continue;
              }
              if (baselineMtime !== undefined && remote.mtime === baselineMtime) {
                console.log(`[LANote] [diag] syncConfig ${wireRelPath}: remote unchanged since last sync -> fast-forward upload`);
                const data = await this.app.vault.adapter.readBinary(local.path);
                await this.transport.uploadFile(wireRelPath, data, local.stat.mtime);
                this.baseline.set(wireRelPath, local.stat.mtime);
                actionsCount++;
                continue;
              }
            }

            // Contents or timestamps differ. Let's read both.
            const localData = await this.app.vault.adapter.readBinary(local.path);
            const remoteData = await this.transport.downloadFile(wireRelPath);

            // Compare binary content quickly
            const localBytes = new Uint8Array(localData);
            const remoteBytes = new Uint8Array(remoteData);
            let contentsMatch = localBytes.length === remoteBytes.length;
            if (contentsMatch) {
              for (let i = 0; i < localBytes.length; i++) {
                if (localBytes[i] !== remoteBytes[i]) {
                  contentsMatch = false;
                  break;
                }
              }
            }

            if (contentsMatch) {
              console.log(`[LANote] [diag] syncConfig ${wireRelPath}: contents match, aligning timestamps`);
              // Contents match exactly; just align the timestamps to the newest modified time
              await resolveByLatestMtime({
                app: this.app, transport: this.transport, wireRelPath, vaultRelPath,
                localData, remoteData, localMtime: local.stat.mtime, remoteMtime: remote.mtime,
              });
              if (needsSyncBaseline(wireRelPath)) this.baseline.set(wireRelPath, Math.max(local.stat.mtime, remote.mtime));
              if (detectFileType(wireRelPath) === 'canvas') recordKnownIdsFromBytes(this.canvasIds, wireRelPath, localData);
            } else {
              // Conflict: Contents are different and timestamps differ.
              console.log(`[LANote] [diag] syncConfig ${wireRelPath}: conflict (localMtime=${local.stat.mtime}, remoteMtime=${remote.mtime})`);
              switch (detectFileType(wireRelPath)) {
                case 'excalidraw': {
                  await resolveExcalidrawConflict({
                    app: this.app,
                    transport: this.transport,
                    wireRelPath,
                    vaultRelPath,
                    localData,
                    remoteData,
                    localMtime: local.stat.mtime,
                    remoteMtime: remote.mtime,
                  });
                  if (needsSyncBaseline(wireRelPath)) {
                    // Re-stat rather than assume a value: resolveExcalidrawConflict
                    // computes its own merged mtime internally and doesn't return it.
                    const postMergeStat = await this.app.vault.adapter.stat(local.path);
                    if (postMergeStat) this.baseline.set(wireRelPath, postMergeStat.mtime);
                  }
                  actionsCount++;
                  break;
                }
                case 'canvas': {
                  await resolveCanvasConflict({
                    app: this.app,
                    transport: this.transport,
                    wireRelPath,
                    vaultRelPath,
                    localData,
                    remoteData,
                    localMtime: local.stat.mtime,
                    remoteMtime: remote.mtime,
                    canvasIds: this.canvasIds,
                  });
                  if (needsSyncBaseline(wireRelPath)) {
                    // Re-stat rather than assume a value: resolveCanvasConflict
                    // computes its own merged mtime internally and doesn't return it.
                    const postMergeStat = await this.app.vault.adapter.stat(local.path);
                    if (postMergeStat) this.baseline.set(wireRelPath, postMergeStat.mtime);
                  }
                  actionsCount++;
                  break;
                }
                case 'markdown': {
                  // ELEGANT AUTOMATIC CRDT NOTE MERGE!
                  const didAct = await resolveMarkdownConflict({
                    app: this.app,
                    transport: this.transport,
                    wireRelPath,
                    vaultRelPath,
                    localData,
                    remoteData,
                    localMtime: local.stat.mtime,
                    remoteMtime: remote.mtime,
                    getActiveLivePaths,
                  });
                  if (!didAct) continue;
                  actionsCount++;
                  break;
                }
                case 'json': {
                  await resolveJsonConflict({
                    app: this.app,
                    transport: this.transport,
                    wireRelPath,
                    vaultRelPath,
                    localBytes,
                    remoteBytes,
                    localData,
                    remoteData,
                    localMtime: local.stat.mtime,
                    remoteMtime: remote.mtime,
                  });
                  actionsCount++;
                  break;
                }
                default: {
                  // No dedicated resolver for this type -- resolve silently via latest mtime.
                  console.log(`[LANote] Silently resolving binary conflict for ${wireRelPath} via latest mtime`);
                  await resolveByLatestMtime({
                    app: this.app, transport: this.transport, wireRelPath, vaultRelPath,
                    localData, remoteData, localMtime: local.stat.mtime, remoteMtime: remote.mtime,
                  });
                  actionsCount++;
                  break;
                }
              }
            }
          }
        }
      }

      await flushStores(this.plugin, [this.baseline, this.canvasIds]);

      if (!silent) new Notice(actionsCount > 0 ? `Sync complete (${actionsCount} updated)` : 'Shared folder in sync.', 2000);
      // Silent (periodic-sync) passes skip the Notice above, so log instead -- but only when something actually changed, since this can run every few seconds.
      else if (actionsCount > 0) console.log(`[LANote] Periodic sync applied ${actionsCount} change(s) for ${this.sharedFolder}`);
    } catch (e: any) {
      console.error('[LANote] Sync Error:', e);
      if (!silent) {
        const errMsg = e.message || String(e);
        new Notice(`Sync failed: ${errMsg}`, 5000);
      }
    } finally {
      this.isSyncing = false;
    }
  }
}
