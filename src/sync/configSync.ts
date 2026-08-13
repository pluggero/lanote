import { App, Notice } from 'obsidian';
import { type RoomKeys, derivePathToken } from '../crypto';
import { ensureParentDirsExist, writeBinaryFile, deleteLocalFile } from '../vaultFs';
import { toWireRelPath, toVaultRelPath, shouldIgnore } from '../syncPaths';
import { SyncTransport } from './syncTransport';
import { resolveMarkdownConflict } from './mergeMarkdown';
import { resolveJsonConflict } from './mergeJson';

export class ConfigSyncEngine {
  // Instance-level (not static): with multi-room support, each room gets its
  // own engine instance, and one room's sync shouldn't block another's.
  private isSyncing = false;
  private transport: SyncTransport;

  constructor(
    private app: App,
    public serverUrl: string,
    private roomKeys: RoomKeys,
    // Vault-relative path of the folder being shared ("" means the whole vault).
    // Devices are allowed to store this folder under different local names --
    // everything on the wire uses paths relative to it, never the vault-absolute path.
    public sharedFolder: string
  ) {
    this.transport = new SyncTransport(serverUrl, roomKeys);
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
   * @param getActiveLivePaths Returns the wire-relative paths currently owned by an
   * active live-collab session (main.ts's activeSyncs) elsewhere in the plugin, evaluated
   * fresh -- not a single Set snapshotted before this call -- because this scan awaits a
   * disk/network round trip per file and can run for seconds; a file can go live (or stop
   * being live) partway through. Skipped only for the conflict-resolution branch below
   * (both a local and remote copy already exist) -- that session is already the
   * authoritative, correctly-synchronized owner of that file's content and room-state
   * snapshot, so without this exclusion this REST-based scan and the live session would
   * independently read-modify-write the same room-state key with no coordination: each
   * side's write reintroduces a mismatch the other detects as a fresh "conflict" next
   * time, causing a runaway loop of CRDT merges that duplicates/corrupts content instead
   * of converging. Re-checked again immediately before the merge write below, since a
   * session can also start during the awaits in between. The initial-upload branch
   * (local-only, i.e. a brand-new file) is deliberately NOT covered by this exclusion: a
   * live session never touches the file-body manifest itself, so that upload is the only
   * thing that ever makes a newly created, actively open file visible to other peers at
   * all.
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
          // File exists only locally -> Upload. Not skipped for
          // activeLivePaths: a live-collab session never touches the file-
          // body manifest itself (only the room-state CRDT snapshot), so
          // this is the only thing that ever puts a brand-new file on the
          // server -- skipping it here would leave a just-created, actively
          // open note invisible to every other peer for as long as it stays
          // open.
          const data = await this.app.vault.adapter.readBinary(local.path);
          await this.transport.uploadFile(wireRelPath, data, local.stat.mtime);
          actionsCount++;
        } else if (!local && remote) {
          console.log(`[LANote] [diag] syncConfig ${wireRelPath}: remote-only -> downloading`);
          // File exists only remotely -> Download
          await ensureParentDirsExist(this.app, vaultRelPath);
          const data = await this.transport.downloadFile(wireRelPath);
          await writeBinaryFile(this.app, vaultRelPath, data);
          actionsCount++;
        } else if (local && remote) {
          if (getActiveLivePaths().has(wireRelPath)) continue;

          // File exists in both -> Check for modification differences
          const timeDiff = Math.abs(local.stat.mtime - remote.mtime);

          if (timeDiff > 2000) {
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
              if (local.stat.mtime > remote.mtime) {
                await this.transport.uploadFile(wireRelPath, localData, local.stat.mtime);
              } else {
                await writeBinaryFile(this.app, vaultRelPath, remoteData);
              }
            } else {
              // Conflict: Contents are different and timestamps differ.
              console.log(`[LANote] [diag] syncConfig ${wireRelPath}: conflict (localMtime=${local.stat.mtime}, remoteMtime=${remote.mtime})`);
              if (wireRelPath.endsWith('.md')) {
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
              } else if (wireRelPath.endsWith('.json')) {
                // Elegant automatic JSON merge
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
              } else {
                // Non-JSON/Non-Markdown binary files: Resolve silently via latest modification time (mtime)
                console.log(`[LANote] Silently resolving binary conflict for ${wireRelPath} via latest mtime`);
                if (local.stat.mtime > remote.mtime) {
                  await this.transport.uploadFile(wireRelPath, localData, local.stat.mtime);
                } else {
                  await writeBinaryFile(this.app, vaultRelPath, remoteData);
                }
                actionsCount++;
              }
            }
          }
        }
      }

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
