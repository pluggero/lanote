import { Awareness } from 'y-protocols/awareness';
import { WebsocketProvider } from 'y-websocket';
import type { SyncSession } from '../lib/types';
import type LANotePlugin from '../main';

/**
 * Our relay is a dumb byte pipe with no server-side Yjs, so it can't
 * broadcast an awareness removal on disconnect itself -- we announce it
 * ourselves before closing, or peers keep seeing our last cursor until
 * their own 30s awareness timeout. The wait gives EncryptingWebSocket's
 * async encrypt step (encryptedSocket.ts) a moment to actually send it
 * before the socket closes.
 */
export async function disconnectGracefully(sync: { awareness: Awareness, provider?: WebsocketProvider, flushSnapshot?: () => void }, opts: { flush?: boolean } = {}): Promise<void> {
  if (opts.flush !== false) sync.flushSnapshot?.();
  console.log('[LANote] [diag] disconnectGracefully: start, clearing awareness');
  sync.awareness.setLocalState(null);
  await new Promise(resolve => setTimeout(resolve, 100));
  if (sync.provider) {
    console.log('[LANote] [diag] disconnectGracefully: closing provider');
    // destroy() already calls disconnect() internally (y-websocket source)
    // -- calling both closes the underlying socket twice, which is what
    // produced the "WebSocket is already in CLOSING or CLOSED state" warning.
    sync.provider.destroy();
  }
}

/**
 * Detaches everything doc.destroy() won't clean up itself: the ytext.observe
 * disk-writeback listener (doc.destroy() only clears doc.on(...) listeners,
 * not Y.Text-level observers) and every bound leaf's Y.UndoManager (which
 * otherwise only self-destroys with the whole doc). Call before sync.doc.destroy().
 */
export function disposeSyncSession(sync: SyncSession): void {
  if (sync.ytextObserver) {
    sync.doc.getText('content').unobserve(sync.ytextObserver);
  }
  for (const undoManager of sync.undoManagers) {
    undoManager.destroy();
  }
  sync.undoManagers.clear();
}

// Returns the disconnect promise (not awaited internally) so both awaiting and fire-and-forget callers work unchanged.
export function teardownSyncSession(plugin: LANotePlugin, path: string, sync: SyncSession, opts: { flush?: boolean } = {}): Promise<void> {
  const t = plugin.retryTimeouts.get(path);
  if (t) { clearTimeout(t); plugin.retryTimeouts.delete(path); }
  plugin.activeSyncs.delete(path);
  plugin.diskDebouncers.delete(path);
  return disconnectGracefully(sync, opts).then(() => { disposeSyncSession(sync); sync.doc.destroy(); });
}
