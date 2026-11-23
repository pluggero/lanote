import type LANotePlugin from '../main';
import type { PendingDeletion } from '../sync/configSync';
import { ConfirmModal } from '../settings/modals';
import { withPendingExclusion } from './pendingSyncPaths';
import { activeWireRelPathsForRoom } from './roomLookup';

function share(count: number, totalBefore: number): string {
  return `${count} of ${totalBefore} files (${Math.round((count / totalBefore) * 100)}%)`;
}

/** Resolves true on confirm, false on cancel or dismiss. */
function askMassDeletion(plugin: LANotePlugin, body: string, paths: string[], confirmText: string, cancelText: string): Promise<boolean> {
  return new Promise(resolve => {
    new ConfirmModal(plugin.app, {
      title: 'LANote - Possible mass deletion',
      body,
      items: [...paths].sort(),
      confirmText,
      cancelText,
      warning: true,
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false),
    }).open();
  });
}

/** Peer deleted files this device still has: delete local copies, or restore them for everyone. */
export function promptReceivedMassDeletion(
  plugin: LANotePlugin,
  roomId: string,
  sharedFolder: string,
  pending: PendingDeletion[],
  totalBefore: number
): void {
  const paths = pending.map(p => p.wireRelPath);
  // Holds the paths synchronously, before the next sync pass can touch them.
  void withPendingExclusion(roomId, paths, async () => {
    const confirmed = await askMassDeletion(
      plugin,
      `${share(pending.length, totalBefore)} in "${sharedFolder}" were deleted on another device. Undo the deletion for every peer, or delete them here too?`,
      paths,
      'Delete here too',
      'Undo for everyone'
    );
    // Looked up after the decision: the runtime may have been rebuilt meanwhile.
    const engine = plugin.roomRuntimes.get(roomId)?.configSyncEngine;
    if (!engine) return;
    if (confirmed) {
      await engine.applyDeletions(pending, () => activeWireRelPathsForRoom(plugin, roomId), (path) => plugin.abandonAndCloseFile(path));
    } else {
      await engine.restoreDeletedFiles(pending);
    }
  }).catch(e => console.warn('[LANote] Applying mass-deletion decision failed:', e));
}

/** Local mass deletion not yet pushed. Resolves true to push it, false to restore the files. */
export function confirmSentMassDeletion(plugin: LANotePlugin, sharedFolder: string, paths: string[], totalBefore: number): Promise<boolean> {
  return askMassDeletion(
    plugin,
    `You deleted ${share(paths.length, totalBefore)} in "${sharedFolder}". Delete them for every peer, or restore them?`,
    paths,
    'Push this deletion',
    'Restore my files'
  );
}
