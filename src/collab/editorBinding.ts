import { TFile, MarkdownView } from 'obsidian';
import * as Y from 'yjs';
import { EditorView } from '@codemirror/view';
import { Compartment } from '@codemirror/state';
import { collaborationExtension } from './collabExtension';
import type LANotePlugin from '../main';

// Registered once via plugin.registerEditorExtension() in main.ts, not
// created ad hoc per-leaf -- a compartment outside every EditorState
// Obsidian builds would make reconfigure() a silent no-op on file switch.
export const collabCompartment = new Compartment();

/** Every currently-open MarkdownView editing path, across all leaves. */
export function leavesForPath(plugin: LANotePlugin, path: string): MarkdownView[] {
  const views: MarkdownView[] = [];
  plugin.app.workspace.iterateAllLeaves((leaf) => {
    if (leaf.view instanceof MarkdownView && leaf.view.file?.path === path) views.push(leaf.view);
  });
  return views;
}

/**
 * Clears this leaf's collab binding if it's now showing a different file
 * than its CodeMirror instance was last bound to. Obsidian reuses one
 * EditorView per leaf across file switches, and the new file's collab
 * session can take a moment to rebind -- without this, a stray keystroke in
 * that gap would route into the old file's Y.Doc, which is about to be
 * destroyed.
 */
export function detachStaleEditorBinding(plugin: LANotePlugin, view: MarkdownView) {
  if (!view.file) return;
  const cm = (view.editor as any)?.cm as EditorView | undefined;
  if (!cm) return;
  const sync = plugin.activeSyncs.get(view.file.path);
  if ((cm as any)._lanoteBoundSync === sync) return;
  cm.dispatch({ effects: collabCompartment.reconfigure([]) });
  (cm as any)._lanoteBoundSync = undefined;
}

export function configureEditorForFile(plugin: LANotePlugin, file: TFile) {
  const sync = plugin.activeSyncs.get(file.path);
  if (!sync) return;
  // Binding before initializeCollab() decides how to hydrate would reconcile
  // CodeMirror's plain disk content into a still-empty ytext, then CRDT-merge
  // the real hydrated snapshot against that as if they were concurrent edits.
  // No-op here; initializeCollab() calls this itself once ready.
  if (!sync.initialized) return;

  let retries = 0;
  const bind = () => {
    // A newer generation (file closed + reopened while this retry loop
    // waited for `cm`) may have replaced this path's activeSyncs entry.
    // Dispatching this stale generation's ytext/awareness would silently
    // orphan live sync: transact() doesn't check isDestroyed, so keystrokes
    // would keep "succeeding" at the CRDT level while reaching no one.
    if (plugin.activeSyncs.get(file.path) !== sync) return;

    // Bind every leaf showing this file -- it can be open in two panes at once.
    let boundAny = false;
    plugin.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path) {
        const cm = (leaf.view.editor as any).cm as EditorView;
        if (!cm) return;

        // Can be re-entered for an already-bound file (e.g. switching
        // between two open files repeatedly) -- skip the clear/rebuild
        // dance, which would otherwise leak a fresh Y.UndoManager on every
        // call. Compared by session identity, not path: a reopened file
        // gets a brand-new SyncSession under the same path.
        if ((cm as any)._lanoteBoundSync === sync) {
          boundAny = true;
          console.log(`[LANote] [diag] configureEditorForFile: ${file.path} already bound, skipping rebind`);
          return;
        }

        // Override hasFocus to return true whenever the active Markdown view's path matches the file path.
        // This prevents y-codemirror from clearing cursor awareness state during focus transitions.
        try {
          Object.defineProperty(cm, 'hasFocus', {
            get: () => {
              return plugin.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path === file.path;
            },
            configurable: true
          });
        } catch (e) {
          console.warn('[LANote] Failed to override hasFocus getter:', e);
        }

        const ytext = sync.doc.getText('content');

        // y-codemirror.next's own cursor broadcast only runs when real
        // OS/window focus is present -- with two Obsidian windows open,
        // only one ever holds that. This listener broadcasts unconditionally
        // so the other window's cursor isn't silently dropped.
        const cursorBroadcastExtension = EditorView.updateListener.of((update) => {
          if (!update.selectionSet) return;
          const sel = update.state.selection.main;
          sync.awareness.setLocalStateField('cursor', {
            anchor: Y.createRelativePositionFromTypeIndex(ytext, sel.anchor),
            head: Y.createRelativePositionFromTypeIndex(ytext, sel.head)
          });
        });

        // yCollab only syncs changes from attach onward, so ytext (already
        // authoritative by this point) must be pulled into cm here, not the
        // reverse -- cm's stale disk-load pushed into ytext would silently
        // revert and rebroadcast a live peer's edits as if they were new.
        const cmContent = cm.state.doc.toString();
        const ytextContent = ytext.toString();
        const initialChanges = cmContent !== ytextContent
          ? { from: 0, to: cm.state.doc.length, insert: ytextContent }
          : undefined;

        // yCollab()'s ySync/yRemoteSelections/yUndoManager ViewPlugin
        // objects read ytext/awareness only once, in their constructor --
        // CodeMirror's compartment diffing keeps a plugin's instance alive
        // across reconfigure() whenever the plugin reference is unchanged,
        // so reconfiguring straight from one file's plugins to another's
        // would keep them bound to the previous file's destroyed Y.Doc,
        // silently swallowing every keystroke. The dispatch above clears
        // the compartment to empty first, forcing the dispatch below to
        // construct fresh instances.
        cm.dispatch({
          ...(initialChanges ? { changes: initialChanges } : {}),
          effects: collabCompartment.reconfigure([])
        });

        // Explicit, tracked Y.UndoManager instead of yCollab()'s implicit
        // one (whose doc.on('afterTransaction') listener would otherwise
        // outlive individual rebinds). disposeSyncSession() destroys it.
        const undoManager = new Y.UndoManager(ytext);
        sync.undoManagers.add(undoManager);

        cm.dispatch({
          effects: collabCompartment.reconfigure([
            ...collaborationExtension(ytext, sync.awareness, undoManager),
            cursorBroadcastExtension
          ])
        });
        (cm as any)._lanoteBoundSync = sync;

        // Force awareness ping so remote peers immediately see our cursor
        const pingAwareness = () => {
          if (!(cm as any).destroyed) {
            const localState = sync.awareness.getLocalState();
            if (localState) {
              sync.awareness.setLocalState({ ...localState });
            }
          }
        };
        setTimeout(pingAwareness, 50);
        setTimeout(pingAwareness, 500); // Follow-up ping for reliability

        boundAny = true;
        console.log(`[LANote] Editor bound for ${file.path} (provider.synced=${sync.provider?.synced ?? 'n/a'})`);
      }
    });
    if (!boundAny && retries < 20) {
      retries++;
      setTimeout(bind, 100);
    } else if (!boundAny) {
      console.warn(`[LANote] Could not bind editor for ${file.path} after ${retries} retries`);
    }
  };
  bind();
}
