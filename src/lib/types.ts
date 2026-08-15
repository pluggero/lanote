import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { WebsocketProvider } from 'y-websocket';
import { type RoomKeys } from './crypto';
import type { ConfigSyncEngine } from '../sync/configSync';

export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected';

export interface RoomRuntime {
  kind: 'hosted' | 'joined';
  roomKeys: RoomKeys;
  configSyncEngine: ConfigSyncEngine;
}

export interface SyncSession {
  doc: Y.Doc;
  awareness: Awareness;
  provider?: WebsocketProvider;
  // The disk-writeback listener registered in initializeCollab() -- Y.Doc.destroy()
  // does not remove Y.Text-level observers, only doc.on(...) listeners, so this must
  // be unobserved explicitly wherever the session is torn down (see disposeSyncSession()).
  ytextObserver?: (event: Y.YTextEvent, transaction: Y.Transaction) => void;
  // One Y.UndoManager per bound editor leaf (collaborationExtension() takes an explicit
  // instance now instead of letting yCollab() construct one implicitly on every rebind).
  // Y.UndoManager only self-destroys when the whole Y.Doc is destroyed, so these must be
  // destroyed explicitly too, in case the session outlives an individual bind.
  undoManagers: Set<Y.UndoManager>;
  // Set true by initializeCollab() only once it has decided (and applied) whether this
  // session hydrates from a live peer or a stored snapshot. configureEditorForFile() must
  // not bind an editor before this -- syncFile()'s "already active" reuse branch can be
  // reentered (Obsidian sometimes fires active-leaf-change more than once for one file
  // switch) while a brand-new session is still mid-connect, and binding then reconciles
  // CodeMirror's plain disk content into a still-empty ytext; when the real hydrated
  // snapshot lands moments later it gets CRDT-merged against that premature reconcile as
  // if they were two independent edits, corrupting the note.
  initialized: boolean;
  // Ungated version of syncFile()'s debounced room-state push, invoked unconditionally by
  // disconnectGracefully() before tearing this session down, so a pending 3s-debounced push
  // doesn't get silently dropped once this session is already removed from activeSyncs (the
  // debounced push's own isCurrentSync() guard would otherwise always no-op it here). Guarded
  // by `initialized` only, not isCurrentSync().
  flushSnapshot?: () => void;
}
