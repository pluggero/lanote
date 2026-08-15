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
  // Disk-writeback listener from initializeCollab() -- doc.destroy() doesn't
  // remove Y.Text-level observers, so this must be unobserved explicitly
  // (disposeSyncSession()).
  ytextObserver?: (event: Y.YTextEvent, transaction: Y.Transaction) => void;
  // One Y.UndoManager per bound editor leaf; only self-destroys with the
  // whole Y.Doc, so must be destroyed explicitly if the session outlives a bind.
  undoManagers: Set<Y.UndoManager>;
  // True once initializeCollab() has decided and applied how this session
  // hydrates. configureEditorForFile() must not bind before this -- binding
  // against a still-empty ytext would let a hydrated snapshot landing later
  // get CRDT-merged against that premature reconcile as an unrelated edit.
  initialized: boolean;
  // Ungated version of the debounced room-state push, called unconditionally
  // by disconnectGracefully() so a pending push isn't dropped once this
  // session is already removed from activeSyncs (its own isCurrentSync()
  // guard would otherwise no-op it here).
  flushSnapshot?: () => void;
}
