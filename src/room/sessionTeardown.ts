import { Awareness } from 'y-protocols/awareness';
import { WebsocketProvider } from 'y-websocket';
import type { SyncSession } from '../types';

/**
 * Our relay is a dumb byte pipe with no server-side Yjs (see server.py) --
 * unlike a classic y-websocket server, it can't notice a peer disconnect
 * and broadcast an awareness removal to everyone else itself. We have to
 * say so ourselves before closing, or other peers keep seeing our last
 * cursor position until their own 30s Yjs awareness timeout eventually
 * clears it. Give the encrypted send a moment to actually go out first:
 * EncryptingWebSocket.send() (encryptedSocket.ts) queues through an async
 * encrypt step, so closing immediately after setLocalState(null) risks
 * the socket closing before that message is even transmitted.
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
 * Detaches everything this session registered directly on its Y.Doc/Y.Text
 * that doc.destroy() itself won't clean up: the disk-writeback ytext.observe
 * listener (Y.Doc.destroy() only clears doc.on(...) listeners, not Y.Text-level
 * observers) and every Y.UndoManager created for a bound editor leaf (an
 * UndoManager only self-destroys once its own doc is destroyed -- calling it
 * explicitly here means it never outlives an individual bind/rebind either).
 * Always call this before sync.doc.destroy().
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
