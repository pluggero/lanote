import { TFile, TAbstractFile, MarkdownView, Notice, debounce } from 'obsidian';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { WebsocketProvider } from 'y-websocket';
import { reconcileYText } from '../lib/reconcile';
import { touchFileMtime } from '../lib/vaultFs';
import { normalizeServerUrl } from '../lib/serverUrl';
import { toWireRelPath } from '../lib/syncPaths';
import { derivePathToken } from '../lib/crypto';
import { makeEncryptingWebSocket } from './encryptedSocket';
import { detectFileType } from '../sync/filetypes/detectFileType';
import type { SyncSession } from '../lib/types';
import type LANotePlugin from '../main';
import { findHostedOrJoinedRoomForPath, getBackgroundSyncDebouncer, syncRoom } from '../room/roomLookup';
import { disconnectGracefully, disposeSyncSession, teardownSyncSession } from '../room/sessionTeardown';
import { configureEditorForFile, detachStaleEditorBinding, leavesForPath } from './editorBinding';
import { updateStatusBar } from './statusBar';

/** Tears down any activeSyncs entry whose file isn't open in any leaf right now. */
export function cleanupClosedFiles(plugin: LANotePlugin) {
  const openPaths = new Set<string>();
  plugin.app.workspace.iterateAllLeaves((leaf) => {
    if (leaf.view instanceof MarkdownView && leaf.view.file) {
      openPaths.add(leaf.view.file.path);
    }
  });

  for (const [path, sync] of plugin.activeSyncs.entries()) {
    if (!openPaths.has(path)) {
      console.log(`[LANote] Cleaning up closed file: ${path} (doc clientID=${sync.doc.clientID})`);
      // Map bookkeeping is immediate; the graceful awareness-clear +
      // disconnect happens in the background so this handler (which can
      // fire often) doesn't block on it.
      teardownSyncSession(plugin, path, sync);
    }
  }
  updateStatusBar(plugin);
}

/**
 * Tears down path's active session (if any) because its file is gone, not
 * just closed -- unlike cleanupClosedFiles/reconnectAll, skips the final
 * flush (disconnectGracefully's flushSnapshot) since flushing here would
 * re-upload the deleted file's content and undo the deletion.
 */
export function abandonActiveSync(plugin: LANotePlugin, path: string): void {
  const sync = plugin.activeSyncs.get(path);
  if (!sync) return;
  teardownSyncSession(plugin, path, sync, { flush: false });
}

/** Tears down path's active session and closes every leaf showing it, because another peer deleted it. */
export function abandonAndCloseFile(plugin: LANotePlugin, path: string): void {
  new Notice(`LANote: "${path}" was deleted on another device. Closing.`);
  abandonActiveSync(plugin, path);
  for (const view of leavesForPath(plugin, path)) view.leaf.detach();
}

export function reconnectAll(plugin: LANotePlugin) {
  // Clear all retry timers
  for (const timeout of plugin.retryTimeouts.values()) clearTimeout(timeout);
  plugin.retryTimeouts.clear();

  plugin.app.workspace.iterateAllLeaves((leaf) => {
    if (leaf.view instanceof MarkdownView && leaf.view.file) {
      const path = leaf.view.file.path;
      const sync = plugin.activeSyncs.get(path);
      // Remove from map first so syncFile() below creates a fresh session
      // immediately; the old one's graceful awareness-clear + disconnect
      // happens in the background without blocking the reconnect.
      plugin.activeSyncs.delete(path);
      if (sync) {
        disconnectGracefully(sync).then(() => { disposeSyncSession(sync); sync.doc.destroy(); });
      }
      syncFile(plugin, leaf.view.file);
    }
  });
  updateStatusBar(plugin);
}

export async function syncFile(plugin: LANotePlugin, file: TFile) {
  // Excalidraw and Canvas are merged element-wise via the background sync
  // path, not this whole-file Y.Text session -- forcing either open via
  // "Open as Markdown" would otherwise character-diff structured JSON.
  const fileType = detectFileType(file.path);
  if (fileType === 'excalidraw' || fileType === 'canvas') return;

  const match = findHostedOrJoinedRoomForPath(plugin, file.path);
  if (!match) return;
  const runtime = plugin.roomRuntimes.get(match.room.id);
  // Room settings exist but the runtime isn't built yet (e.g. still
  // starting) -- the reconnectAll() that follows startSharing()/joinRoom()
  // will pick this file up once it is.
  if (!runtime) return;
  const { roomKeys, configSyncEngine } = runtime;
  const sharedFolder = match.room.sharedFolder;

  if (plugin.activeSyncs.has(file.path)) {
    configureEditorForFile(plugin, file);
    updateStatusBar(plugin);
    return;
  }

  console.log(`[LANote] Starting sync for ${file.path}`);
  // Anchors the tombstone check in doPushSnapshot: a tombstone before this predates this session; after it means the file was renamed/deleted elsewhere while this session was live.
  const sessionStartedAt = Date.now();
  const doc = new Y.Doc();
  const ytext = doc.getText('content');

  const awareness = new Awareness(doc);
  awareness.setLocalStateField('user', {
    name: plugin.settings.nickname,
    color: plugin.settings.cursorColor,
    colorLight: plugin.settings.cursorColor + '33'
  });

  const wireRelPath = toWireRelPath(sharedFolder, file.path);
  const fileRoomToken = `${roomKeys.roomId}:${await derivePathToken(roomKeys.pathKey, wireRelPath)}`;
  const serverUrl = normalizeServerUrl(plugin.settings.signalingUrl);

  const provider = new WebsocketProvider(serverUrl, fileRoomToken, doc, {
    awareness,
    params: { room: roomKeys.roomId },
    WebSocketPolyfill: makeEncryptingWebSocket(roomKeys) as any
  });

  const sync: SyncSession = { doc, awareness, provider, undoManagers: new Set<Y.UndoManager>(), initialized: false };
  plugin.activeSyncs.set(file.path, sync);
  updateStatusBar(plugin);

  // Prevent duplicate initializations and wait for WebSocket sync OR offline fallback
  let hasInitialized = false;
  // True as long as this closure's session is still the one main.ts considers
  // active for this path -- a rapid file switch can tear down/replace it while
  // we're mid-await, and we must not go on to mutate/bind a torn-down session.
  const isCurrentSync = () => plugin.activeSyncs.get(file.path) === sync;

  // Debounced encrypted snapshot push -- the client-side replacement for the
  // old plaintext server's own autosave, since a zero-knowledge relay never
  // sees CRDT state to persist it itself.
  const HYDRATE_ORIGIN = 'lanote-hydrate';
  const doPushSnapshot = async () => {
    // Pushing here would re-upload and clear another peer's tombstone for this path.
    try {
      const tombstones = await configSyncEngine.getRemoteTombstones();
      const deletedAt = tombstones[await derivePathToken(roomKeys.pathKey, wireRelPath)];
      if (deletedAt !== undefined && deletedAt >= sessionStartedAt) {
        abandonAndCloseFile(plugin, file.path);
        return;
      }
      console.log(`[LANote] [diag] doPushSnapshot ${wireRelPath}: tombstone check passed (deletedAt=${deletedAt}, sessionStartedAt=${sessionStartedAt}) -> pushing`);
    } catch (e) {
      console.warn(`[LANote] Tombstone check failed for ${wireRelPath}, pushing anyway:`, e);
    }

    const update = Y.encodeStateAsUpdate(doc);
    console.log(`[LANote] [diag] pushing room-state snapshot for ${wireRelPath}: ${update.byteLength} bytes`);
    configSyncEngine.putRoomStateSnapshot(wireRelPath, update)
      .catch(e => console.error(`[LANote] Snapshot push failed for ${wireRelPath}:`, e));
    // Keep the plain file-body manifest from going stale too -- otherwise
    // the background folder sync (syncConfig) sees local-disk-vs-manifest
    // drift on every live edit and treats it as a genuine multi-device
    // conflict once this file closes, needlessly re-deriving room-state.
    const bytes = new TextEncoder().encode(ytext.toString()).buffer;
    configSyncEngine.uploadFile(wireRelPath, bytes, Date.now())
      .catch(e => console.error(`[LANote] File-body sync failed for ${wireRelPath}:`, e));
  };
  const snapshotDebouncer = debounce(() => {
    // The session can be torn down (file switched away from) while this
    // 3s debounce is still pending; without this guard it fires later
    // against an already-destroyed doc and pushes a stale snapshot. The
    // final push on a genuine teardown is instead guaranteed by
    // sync.flushSnapshot (see disconnectGracefully()), which deliberately
    // bypasses this same guard.
    if (!isCurrentSync()) return;
    doPushSnapshot();
  }, 3000, true);
  // Bypasses isCurrentSync() on purpose -- disconnectGracefully() only ever calls this
  // as part of this exact session's own deliberate teardown, by which point every call
  // site has already removed it from activeSyncs, so that guard would otherwise always
  // (wrongly) no-op it here.
  sync.flushSnapshot = () => {
    if (!sync.initialized) return;
    doPushSnapshot();
  };
  doc.on('update', (update: Uint8Array, origin: any) => {
    console.log(`[LANote] [diag] doc update for ${wireRelPath}: ${update.byteLength} bytes, origin=${origin === HYDRATE_ORIGIN ? 'hydrate' : typeof origin === 'string' ? origin : (origin?.constructor?.name ?? String(origin))}`);
    if (origin !== HYDRATE_ORIGIN) snapshotDebouncer();
  });

  const initializeCollab = async (viaLiveConnection: boolean) => {
    if (hasInitialized) return;
    hasInitialized = true;

    // Give a concurrently-present live peer a brief chance to actually reply
    // via the real Yjs sync-step1/step2 handshake (provider.synced becomes
    // true once they do) before deciding whether we need our own hydration
    // fallback or local-disk reconcile at all. Not needed on the offline-
    // fallback path -- there's no live peer that could possibly answer there.
    if (viaLiveConnection && !provider.synced) {
      await new Promise(resolve => setTimeout(resolve, 600));
      if (!isCurrentSync()) return;
    }

    if (!provider.synced) {
      // No live peer answered -- hydrate from the last encrypted snapshot,
      // then treat local disk as source of truth on top (seed if empty,
      // merge offline edits otherwise). Skipped once a peer HAS answered:
      // y-websocket rebroadcasts even our HYDRATE_ORIGIN-tagged updates to
      // live peers as normal edits, so applying a separate CRDT history here
      // would duplicate rather than deduplicate against their real reply.
      try {
        const snapshot = await configSyncEngine.getRoomStateSnapshot(wireRelPath);
        if (!isCurrentSync() || provider.synced) return;
        if (snapshot) {
          console.log(`[LANote] [diag] applying hydrated snapshot for ${wireRelPath}: ${snapshot.byteLength} bytes`);
          Y.applyUpdate(doc, snapshot, HYDRATE_ORIGIN);
        }
      } catch (e) {
        console.warn(`[LANote] Failed to hydrate room state for ${wireRelPath}:`, e);
      }
      if (!isCurrentSync() || provider.synced) return;

      // Only seed from disk when no snapshot was actually applied above --
      // otherwise this would revert a real hydrated snapshot to stale disk content.
      if (ytext.length === 0) {
        const currentLocalContent = await plugin.app.vault.read(file);
        if (!isCurrentSync() || provider.synced) return;
        reconcileYText(ytext, currentLocalContent);
      }
    }

    sync.initialized = true;
    configureEditorForFile(plugin, file);

    // Write remote changes back to disk if the file isn't open. Stored on the
    // sync object so disposeSyncSession() can unobserve it on teardown --
    // Y.Doc.destroy() does not remove Y.Text-level observers on its own.
    const ytextObserver = (event: Y.YTextEvent, transaction: Y.Transaction) => {
      if (!transaction.local) {
        let isOpen = false;
        plugin.app.workspace.iterateAllLeaves((leaf) => {
          if (leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path) isOpen = true;
        });
        if (!isOpen) {
          plugin.app.vault.modify(file, ytext.toString()).catch(e => console.error(e));
        }
      }
    };
    sync.ytextObserver = ytextObserver;
    ytext.observe(ytextObserver);
  };

  provider.on('sync', (isSynced: boolean) => {
    if (isSynced) initializeCollab(true);
  });

  // ── Real connection status tracking ──
  provider.on('status', ({ status }: { status: string }) => {
    console.log(`[LANote] Provider status for ${file.path}: ${status}`);

    if (status === 'connected') {
      plugin.connectionStatus = 'connected';
      // Clear any pending retry for this file
      const t = plugin.retryTimeouts.get(file.path);
      if (t) { clearTimeout(t); plugin.retryTimeouts.delete(file.path); }

      // Trigger background shared-folder sync if not already syncing
      syncRoom(plugin, match.room.id, true);

      // provider.on('sync') only fires once a live peer replies -- our dumb
      // relay never does, so it'd never fire with no one else online. Our
      // own hydration is authoritative on its own; initializeCollab() is
      // idempotent and merges in any later peer reply with no risk.
      initializeCollab(true);
    } else if (status === 'connecting') {
      plugin.connectionStatus = 'connecting';
    } else if (status === 'disconnected') {
      plugin.connectionStatus = 'disconnected';
      scheduleRetry(plugin, file, 0);
      // If we fail to connect, initialize offline immediately -- no grace
      // period here, since we're offline and no live peer could race in.
      initializeCollab(false);
    }
    updateStatusBar(plugin);
  });
}

function scheduleRetry(plugin: LANotePlugin, file: TFile, attempt: number) {
  // Don't retry if file was closed
  if (!plugin.activeSyncs.has(file.path)) return;

  const MAX_ATTEMPTS = 5;
  const DELAYS = [3000, 6000, 12000, 24000, 60000];

  if (attempt >= MAX_ATTEMPTS) {
    const url = normalizeServerUrl(plugin.settings.signalingUrl);
    const isLocal = url.includes('localhost') || url.includes('127.0.0.1');
    if (isLocal) {
      new Notice(`LANote: Cannot connect to ${url}. Make sure the server is running (e.g. \`docker compose up -d\`).`, 8000);
    } else {
      new Notice(`LANote: Cannot connect to ${url}. Check the server is running.`, 8000);
    }
    return;
  }

  const delay = DELAYS[attempt] ?? 60000;
  const t = setTimeout(() => {
    const sync = plugin.activeSyncs.get(file.path);
    if (!sync) return;

    console.log(`[LANote] Retry ${attempt + 1}/${MAX_ATTEMPTS} for ${file.path}`);
    if (sync.provider) {
      sync.provider.connect();
    }
  }, delay);

  plugin.retryTimeouts.set(file.path, t);
}

/**
 * Debounced disk-change reconciler for one file path, created lazily and
 * cached on plugin.diskDebouncers (mirrors getBackgroundSyncDebouncer's
 * per-key debouncer cache in room/roomLookup.ts).
 */
export function getDiskSyncDebouncer(plugin: LANotePlugin, path: string): (file: TFile) => void {
  let fn = plugin.diskDebouncers.get(path);
  if (!fn) {
    fn = debounce(async (f: TFile) => {
      const sync = plugin.activeSyncs.get(f.path);
      if (!sync) return;

      // While open, ySync applies every keystroke into ytext synchronously --
      // no disk round-trip needed, and this handler's async read can go
      // stale mid-typing, forcing ytext back to older content. Only
      // reconcile from disk for sessions that aren't the focused pane.
      let isOpen = false;
      plugin.app.workspace.iterateAllLeaves((leaf) => {
        if (leaf.view instanceof MarkdownView && leaf.view.file?.path === f.path) isOpen = true;
      });
      if (isOpen) return;

      const diskContent = await plugin.app.vault.read(f);
      const currentYText = sync.doc.getText('content');
      if (currentYText.toString() !== diskContent) {
        reconcileYText(currentYText, diskContent);
      }
    }, 50, true);
    plugin.diskDebouncers.set(path, fn);
  }
  return fn;
}

/**
 * A live session's relay room token is derived from the file's path, and
 * Obsidian mutates the TFile's .path in place on rename without firing
 * active-leaf-change -- without this, a session live under oldPath would
 * keep talking to that stale token forever. Tears down and rebuilds just
 * this file's session, not via reconnectAll(): that would burst-disconnect
 * every open file over one rename.
 */
export function handleFileRename(plugin: LANotePlugin, file: TAbstractFile, oldPath: string): void {
  const matchNew = findHostedOrJoinedRoomForPath(plugin, file.path);
  if (matchNew) getBackgroundSyncDebouncer(plugin, matchNew.room.id)();
  const matchOld = findHostedOrJoinedRoomForPath(plugin, oldPath);
  if (matchOld && matchOld.room.id !== matchNew?.room.id) getBackgroundSyncDebouncer(plugin, matchOld.room.id)();

  // Tombstone the old wire path so the next background sync doesn't resurrect it.
  if (matchOld && file instanceof TFile) {
    plugin.roomRuntimes.get(matchOld.room.id)?.configSyncEngine.deleteRemoteFile(oldPath);
  }

  // A plain rename doesn't update mtime -- if the new name reuses an old, still-tombstoned path, syncConfig()'s staleness check would otherwise misjudge this fresh rename as a leftover of that old deletion.
  if (matchNew && file instanceof TFile) {
    touchFileMtime(plugin.app, file.path).catch(e => console.warn(`[LANote] Failed to refresh mtime for ${file.path}:`, e));
  }

  const staleSync = plugin.activeSyncs.get(oldPath);
  if (staleSync && file instanceof TFile) {
    // Detach the editor from staleSync's Y.Doc before it's destroyed below.
    for (const view of leavesForPath(plugin, file.path)) detachStaleEditorBinding(plugin, view);
    // flush: false -- flushing would re-upload to the old (just-tombstoned) path and undo the tombstone.
    teardownSyncSession(plugin, oldPath, staleSync, { flush: false });
    syncFile(plugin, file);
  }
}
