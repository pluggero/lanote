import { debounce } from 'obsidian';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { WebsocketProvider } from 'y-websocket';
import { EditorView } from '@codemirror/view';
import { derivePathToken } from '../lib/crypto';
import { normalizeServerUrl } from '../lib/serverUrl';
import { toWireRelPath, isWithinSharedFolder } from '../lib/syncPaths';
import { writeBinaryFile } from '../lib/vaultFs';
import type { SyncSession } from '../lib/types';
import type LANotePlugin from '../main';
import { findHostedOrJoinedRoomForPath } from '../room/roomLookup';
import { detectFileType } from '../sync/filetypes/detectFileType';
import { parseCanvas, serializeCanvas } from '../sync/filetypes/canvas/codec';
import { makeEncryptingWebSocket } from './encryptedSocket';
import { collaborationExtension } from './collabExtension';
import { collabCompartment } from './editorBinding';
import { disconnectGracefully, disposeSyncSession } from '../room/sessionTeardown';
import { updateStatusBar } from './statusBar';

/** One canvas text card's live Yjs session, plus enough identity to tear it down and exclude its file from the background merge (roomLookup.ts's activeWireRelPathsForRoom). */
export interface CanvasCardBinding {
  vaultRelPath: string;
  nodeId: string;
  sync: SyncSession;
  cm: EditorView;
}

function cardKey(vaultRelPath: string, nodeId: string): string {
  return `${vaultRelPath}\0${nodeId}`;
}

/**
 * Runs on every DOM focusin (registered in main.ts) -- canvas cards have no
 * per-card focus event, since focusing a different card in an already-open
 * canvas never fires 'active-leaf-change'. Tears down any bound card that
 * lost real DOM focus, then binds the new focus target if it's a canvas
 * text card. Fails closed: any unexpected shape here just leaves the card
 * covered by the background merge, like any other field.
 */
export function syncActiveCanvasCard(plugin: LANotePlugin): void {
  for (const [key, binding] of [...plugin.activeCardSyncs]) {
    if (!binding.cm.hasFocus) {
      teardownCardSession(plugin, key, binding).catch(e =>
        console.error(`[LANote] Error tearing down card session ${key}:`, e)
      );
    }
  }

  const activeEditor = plugin.app.workspace.activeEditor as any;
  const node = activeEditor?.node;
  const cm = activeEditor?.editor?.cm as EditorView | undefined;
  if (!node?.id || typeof node.text !== 'string' || !cm || (cm as any).destroyed || !cm.hasFocus) return;

  const activeFile = plugin.app.workspace.getActiveFile();
  if (!activeFile || detectFileType(activeFile.path) !== 'canvas') return;

  const key = cardKey(activeFile.path, node.id);
  // Map presence, not `_lanoteBoundSync` (only set once bindEditor() runs,
  // after bindCanvasCard's async hydration) -- otherwise a second focusin
  // mid-hydration would re-enter bindCanvasCard for the same key.
  if (plugin.activeCardSyncs.has(key)) return;

  bindCanvasCard(plugin, activeFile.path, node, cm).catch(e =>
    console.error(`[LANote] Failed to bind live session for canvas card ${key}:`, e)
  );
}

async function bindCanvasCard(plugin: LANotePlugin, vaultRelPath: string, node: { id: string; text: string }, cm: EditorView): Promise<void> {
  const match = findHostedOrJoinedRoomForPath(plugin, vaultRelPath);
  if (!match) return;
  const runtime = plugin.roomRuntimes.get(match.room.id);
  if (!runtime) return;
  const { roomKeys, configSyncEngine } = runtime;
  const wireRelPath = toWireRelPath(match.room.sharedFolder, vaultRelPath);
  // Synthetic id, not a real path -- derivePathToken and the room-state
  // endpoints just HMAC/store whatever string they're given. Distinct from
  // the canvas's own wireRelPath (the background merge's room-state) and
  // every other card's.
  const cardPathId = `${wireRelPath}#card:${node.id}`;
  const key = cardKey(vaultRelPath, node.id);

  // Atomic claim: no `await` between this check and the .set() below, so no
  // concurrent bindCanvasCard call can slip in and register a second
  // binding for this key.
  if (plugin.activeCardSyncs.has(key)) return;
  const doc = new Y.Doc();
  const ytext = doc.getText('content');
  const awareness = new Awareness(doc);
  awareness.setLocalStateField('user', {
    name: plugin.settings.nickname,
    color: plugin.settings.cursorColor,
    colorLight: plugin.settings.cursorColor + '33',
  });

  // Claims the slot before the provider exists (SyncSession.provider is
  // optional) so a concurrent bindCanvasCard call sees it immediately,
  // instead of only once the provider is ready below.
  const sync: SyncSession = { doc, awareness, undoManagers: new Set<Y.UndoManager>(), initialized: false };
  const binding: CanvasCardBinding = { vaultRelPath, nodeId: node.id, sync, cm };
  plugin.activeCardSyncs.set(key, binding);
  updateStatusBar(plugin);

  const isCurrentSync = () => plugin.activeCardSyncs.get(key)?.sync === sync;

  const cardRoomToken = `${roomKeys.roomId}:${await derivePathToken(roomKeys.pathKey, cardPathId)}`;
  // The session claimed above can be torn down while this await is pending
  // (focus already left) -- bail instead of building a provider for a
  // binding nothing references anymore.
  if (!isCurrentSync()) return;
  const serverUrl = normalizeServerUrl(plugin.settings.signalingUrl);
  const provider = new WebsocketProvider(serverUrl, cardRoomToken, doc, {
    awareness,
    params: { room: roomKeys.roomId },
    WebSocketPolyfill: makeEncryptingWebSocket(roomKeys) as any,
  });
  sync.provider = provider;
  const HYDRATE_ORIGIN = 'lanote-hydrate';

  const doPushSnapshot = () => {
    const update = Y.encodeStateAsUpdate(doc);
    configSyncEngine.putRoomStateSnapshot(cardPathId, update)
      .catch(e => console.error(`[LANote] Card snapshot push failed for ${key}:`, e));
  };
  // 1s, not markdown's 3s: a card session only lives while focused, so
  // there's no long idle window to coalesce writes over.
  const snapshotDebouncer = debounce(() => { if (isCurrentSync()) doPushSnapshot(); }, 1000, true);
  sync.flushSnapshot = () => { if (sync.initialized) doPushSnapshot(); };
  doc.on('update', (_update: Uint8Array, origin: any) => {
    if (origin !== HYDRATE_ORIGIN) snapshotDebouncer();
  });

  let hasInitialized = false;
  const initializeCollab = async (viaLiveConnection: boolean) => {
    if (hasInitialized) return;
    hasInitialized = true;

    if (viaLiveConnection && !provider.synced) {
      await new Promise(resolve => setTimeout(resolve, 600));
      if (!isCurrentSync()) return;
    }

    if (!provider.synced) {
      let snapshotApplied = false;
      try {
        const snapshot = await configSyncEngine.getRoomStateSnapshot(cardPathId);
        if (!isCurrentSync() || provider.synced) return;
        if (snapshot) {
          Y.applyUpdate(doc, snapshot, HYDRATE_ORIGIN);
          snapshotApplied = true;
        }
      } catch (e) {
        console.warn(`[LANote] Failed to hydrate room state for card ${key}:`, e);
      }
      if (!isCurrentSync() || provider.synced) return;

      // Seed from node.text only if no snapshot was applied. Keyed on
      // `snapshotApplied`, not `ytext.length === 0`: a genuinely-applied
      // snapshot can itself decode to empty text (a card legitimately
      // emptied by another peer), and conflating that with "nothing
      // applied" would resurrect text that peer already deleted.
      if (!snapshotApplied && node.text.length > 0) {
        doc.transact(() => ytext.insert(0, node.text), HYDRATE_ORIGIN);
      }
    }

    if (!isCurrentSync()) return;
    sync.initialized = true;
    bindEditor();
  };

  const bindEditor = () => {
    if ((cm as any)._lanoteBoundSync === sync) return;

    const cmContent = cm.state.doc.toString();
    const ytextContent = ytext.toString();
    const initialChanges = cmContent !== ytextContent
      ? { from: 0, to: cm.state.doc.length, insert: ytextContent }
      : undefined;

    cm.dispatch({
      ...(initialChanges ? { changes: initialChanges } : {}),
      effects: collabCompartment.reconfigure([]),
    });

    const undoManager = new Y.UndoManager(ytext);
    sync.undoManagers.add(undoManager);

    const cursorBroadcastExtension = EditorView.updateListener.of((update) => {
      if (!update.selectionSet) return;
      const sel = update.state.selection.main;
      awareness.setLocalStateField('cursor', {
        anchor: Y.createRelativePositionFromTypeIndex(ytext, sel.anchor),
        head: Y.createRelativePositionFromTypeIndex(ytext, sel.head),
      });
    });

    cm.dispatch({
      effects: collabCompartment.reconfigure([
        ...collaborationExtension(ytext, awareness, undoManager),
        cursorBroadcastExtension,
      ]),
    });
    (cm as any)._lanoteBoundSync = sync;
  };

  provider.on('sync', (isSynced: boolean) => { if (isSynced) initializeCollab(true); });
  provider.on('status', ({ status }: { status: string }) => {
    if (status === 'connected') initializeCollab(true);
    else if (status === 'disconnected') initializeCollab(false);
    updateStatusBar(plugin);
  });
}

/**
 * Patches this node's `text` in the on-disk `.canvas` file and writes it
 * back -- this layer's actual persistence guarantee, fired once on
 * focus-loss (not per-keystroke, so it can't disrupt the open editor).
 * Reads fresh so it never clobbers unrelated on-disk changes.
 */
async function flushCardTextToDisk(plugin: LANotePlugin, vaultRelPath: string, nodeId: string, text: string): Promise<void> {
  const raw = await plugin.app.vault.adapter.read(vaultRelPath).catch(() => null);
  if (raw === null) return;
  const parsed = parseCanvas(raw);
  if (!parsed) return;
  const node = parsed.nodes.find(n => n.id === nodeId);
  if (!node || typeof node.text !== 'string' || node.text === text) return;
  node.text = text;
  await writeBinaryFile(plugin.app, vaultRelPath, new TextEncoder().encode(serializeCanvas(parsed)).buffer, Date.now());
}

/**
 * Tears down one card's session: detach the editor, flush its text to
 * disk, remove the map entry, then disconnect. The flush must land, and the
 * map entry must still exist, before disconnecting -- activeWireRelPathsForRoom
 * excludes this file only while the provider is connected, so disconnecting
 * first would lift that exclusion mid-write. Fire-and-forget from callers,
 * like onunload()'s existing best-effort teardownSyncSession calls.
 */
async function teardownCardSession(plugin: LANotePlugin, key: string, binding: CanvasCardBinding): Promise<void> {
  const { sync, cm, vaultRelPath, nodeId } = binding;
  if (!(cm as any).destroyed) {
    cm.dispatch({ effects: collabCompartment.reconfigure([]) });
  }
  if ((cm as any)._lanoteBoundSync === sync) (cm as any)._lanoteBoundSync = undefined;

  const finalText = sync.doc.getText('content').toString();

  await flushCardTextToDisk(plugin, vaultRelPath, nodeId, finalText)
    .catch(e => console.error(`[LANote] Failed to flush card text to disk for ${key}:`, e));

  plugin.activeCardSyncs.delete(key);
  updateStatusBar(plugin);

  await disconnectGracefully(sync)
    .then(() => { disposeSyncSession(sync); sync.doc.destroy(); })
    .catch(e => console.error(`[LANote] Error tearing down card session ${key}:`, e));
}

/** Tears down every active card session, e.g. on plugin unload. */
export function teardownAllCanvasCardSessions(plugin: LANotePlugin): void {
  for (const [key, binding] of [...plugin.activeCardSyncs]) {
    teardownCardSession(plugin, key, binding).catch(e =>
      console.error(`[LANote] Error tearing down card session ${key}:`, e)
    );
  }
}

/**
 * Tears down every card session under `sharedFolder`, awaiting all of them.
 * Needed wherever `activeSyncs` is already torn down for a room --
 * `teardownRuntimeForRoom` (stop/leave/renew) and `reconstructDatabase` --
 * since a card session captures its room's keys/configSyncEngine by closure
 * at bind time and nothing else ever refreshes them.
 */
export async function teardownCanvasCardSessionsForRoom(plugin: LANotePlugin, sharedFolder: string): Promise<void> {
  const teardowns: Promise<void>[] = [];
  for (const [key, binding] of [...plugin.activeCardSyncs]) {
    if (isWithinSharedFolder(sharedFolder, binding.vaultRelPath)) {
      teardowns.push(
        teardownCardSession(plugin, key, binding).catch(e =>
          console.error(`[LANote] Error tearing down card session ${key}:`, e)
        )
      );
    }
  }
  await Promise.all(teardowns);
}
