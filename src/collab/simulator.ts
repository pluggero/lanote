import { Notice, MarkdownView } from 'obsidian';
import * as Y from 'yjs';
import type LANotePlugin from '../main';
import { syncFile } from './collabSession';
import { updateStatusBar } from './statusBar';

export function toggleSimulator(plugin: LANotePlugin) {
  if (plugin.simulatorInterval) {
    clearInterval(plugin.simulatorInterval);
    plugin.simulatorInterval = null;
    new Notice('Collaborator simulation stopped.');
    updateStatusBar(plugin);

    for (const sync of plugin.activeSyncs.values()) {
      const mockClientId = 133742;
      sync.awareness.states.delete(mockClientId);
      sync.awareness.emit('change', [{ added: [], updated: [], removed: [mockClientId] }]);
    }
    return;
  }

  const activeView = plugin.app.workspace.getActiveViewOfType(MarkdownView);
  if (!activeView || !activeView.file) {
    new Notice('Please open a note to simulate collaboration.');
    return;
  }

  const sync = plugin.activeSyncs.get(activeView.file.path);
  if (!sync) {
    new Notice('Active note is not synced. Opening session...');
    syncFile(plugin, activeView.file);
    return;
  }

  const mockClientId = 133742;
  let typingDirection = 1;
  let mockHead = 0;

  plugin.simulatorInterval = setInterval(() => {
    const currentView = plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (!currentView || !currentView.file) return;
    const currentSync = plugin.activeSyncs.get(currentView.file.path);
    if (!currentSync) return;

    const ytext = currentSync.doc.getText('content');
    const docLength = ytext.length;
    if (docLength === 0) return;

    if (Math.random() < 0.2) {
      mockHead = Math.floor(Math.random() * docLength);
    } else {
      mockHead += typingDirection * Math.floor(Math.random() * 3 + 1);
      if (mockHead >= docLength) { mockHead = docLength - 1; typingDirection = -1; }
      else if (mockHead <= 0) { mockHead = 0; typingDirection = 1; }
    }

    const mockAnchorAbs = Math.random() < 0.35
      ? Math.max(0, mockHead - Math.floor(Math.random() * 20 + 5))
      : mockHead;

    // Use Y.RelativePosition so the cursor is compatible with yCollab's
    // yRemoteSelections plugin, which reads cursor.anchor and cursor.head
    // as relative positions.
    const anchor = Y.createRelativePositionFromTypeIndex(ytext, mockAnchorAbs);
    const head   = Y.createRelativePositionFromTypeIndex(ytext, mockHead);

    currentSync.awareness.states.set(mockClientId, {
      user: { name: 'Jane Doe (Simulated)', color: '#ec4899', colorLight: '#ec489922' },
      cursor: { anchor, head }
    });
    currentSync.awareness.emit('change', [{ added: [], updated: [mockClientId], removed: [] }]);
  }, 1000);

  new Notice('Collaborator simulation started (Jane Doe is active).');
  updateStatusBar(plugin);
}
