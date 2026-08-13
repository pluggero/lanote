import { TFile, MarkdownView } from 'obsidian';
import * as Y from 'yjs';
import { EditorView } from '@codemirror/view';
import { Compartment } from '@codemirror/state';
import { collaborationExtension } from '../collabExtension';
import type LANotePlugin from '../main';

// Registered once via plugin.registerEditorExtension() in main.ts so it's part
// of every EditorState Obsidian builds, including the fresh ones it creates on
// file switch -- a compartment created ad hoc per-leaf falls out of the state
// tree on the next switch, making reconfigure() a silent no-op.
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
 * Immediately clears this leaf's collab bindings if it's now showing a
 * different file than the one its CodeMirror instance was last bound to.
 * Obsidian reuses one EditorView per leaf across file switches, but the
 * new file's own (async) collab session can take a moment to finish
 * connecting/hydrating before configureEditorForFile() rebinds it -- in
 * that gap, the OLD file's collab plugins are still attached, and would
 * otherwise route any stray keystroke (or Obsidian's own async file-load)
 * into the old file's Y.Doc, which cleanupClosedFiles() is about to
 * destroy. Clearing it right away closes that window.
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
  // syncFile()'s "already active" reuse branch can call this while a brand-new
  // session is still mid-connect (Obsidian can fire active-leaf-change more than
  // once for a single file switch). Binding before initializeCollab() has decided
  // how to hydrate would reconcile CodeMirror's plain disk content into a still-
  // empty ytext, which then gets CRDT-merged against the real hydrated snapshot as
  // if they were unrelated concurrent edits -- see the SyncSession.initialized doc
  // comment. No-op here; initializeCollab() calls this itself once ready.
  if (!sync.initialized) return;

  let retries = 0;
  const bind = () => {
    // A newer generation (file closed + reopened while this retry loop
    // was still waiting for `cm` to exist -- up to 2s below) may have
    // already replaced this path's entry in activeSyncs. Dispatching this
    // stale generation's ytext/awareness onto the Obsidian-reused
    // CodeMirror instance would silently orphan live sync: Y.Doc.destroy()
    // wipes doc.on('update') listeners, but transact() never checks
    // isDestroyed, so keystrokes routed here would keep "succeeding" at
    // the CRDT level with zero errors while never reaching anyone who
    // reads/pushes them. Bail out -- the newer generation's own
    // configureEditorForFile() call already handles binding.
    if (plugin.activeSyncs.get(file.path) !== sync) return;

    // Bind every leaf currently showing this file, not just the first --
    // the same file can be open in two panes at once, and each pane owns
    // its own CodeMirror EditorView that needs its own binding.
    let boundAny = false;
    plugin.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path) {
        const cm = (leaf.view.editor as any).cm as EditorView;
        if (!cm) return;

        // configureEditorForFile() can be re-entered for a file that's
        // already correctly bound -- syncFile()'s "already active" branch
        // calls it on every active-leaf-change back to an already-syncing
        // file (e.g. switching between two open files repeatedly). Redoing
        // the clear/rebuild dance below every time is wasted work and,
        // worse, constructs a brand new Y.UndoManager on every call (see
        // collaborationExtension()) that then sits around doing nothing
        // useful until this file's session finally tears down. Skip
        // straight through when this leaf's cm is already bound to this
        // exact session object -- compared by identity, not path, since a
        // closed-and-reopened file gets a brand-new SyncSession under the
        // same path.
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

        // y-codemirror.next's own cursor-broadcast logic only runs when
        // update.view.dom.ownerDocument.hasFocus() is true -- real OS/window
        // focus, not just "this pane is Obsidian's active leaf" (which the
        // hasFocus override above already handles). With two Obsidian
        // windows open on one machine, only one ever holds that, so the
        // other's cursor position would never get computed or broadcast.
        // This listener does the same computation unconditionally, so our
        // cursor still broadcasts regardless of window-level focus.
        const cursorBroadcastExtension = EditorView.updateListener.of((update) => {
          if (!update.selectionSet) return;
          const sel = update.state.selection.main;
          sync.awareness.setLocalStateField('cursor', {
            anchor: Y.createRelativePositionFromTypeIndex(ytext, sel.anchor),
            head: Y.createRelativePositionFromTypeIndex(ytext, sel.head)
          });
        });

        // yCollab never reconciles the editor's existing document with
        // ytext on attach -- it only syncs changes from this point
        // forward. By the time this runs, initializeCollab() has already
        // established ytext's authoritative content (either from a live
        // peer's real sync-step2 reply, or from its own disk-hydration
        // reconcile) -- ytext, not cm, is the source of truth here. What
        // cm currently displays is most commonly just Obsidian's own
        // disk-load for this file, which can be stale relative to a live
        // peer's edits ytext already has. Pushing cm's content into ytext
        // (as this used to do) would silently revert ytext back to that
        // stale copy and broadcast the reversion to every peer as a real
        // edit. Instead, pull ytext's content into cm as part of the same
        // dispatch that clears the compartment below, so the fresh
        // ySync/yRemoteSelections plugin instances are constructed against
        // a cm buffer that already matches ytext.
        const cmContent = cm.state.doc.toString();
        const ytextContent = ytext.toString();
        const initialChanges = cmContent !== ytextContent
          ? { from: 0, to: cm.state.doc.length, insert: ytextContent }
          : undefined;

        // collaborationExtension now wraps yCollab internally.
        // It passes both ytext and awareness so that yCollab can use
        // Y.RelativePosition for cursor tracking (the correct approach).
        //
        // yCollab() returns the SAME singleton ySync/yRemoteSelections/
        // yUndoManager ViewPlugin objects on every call (see
        // node_modules/y-codemirror.next/src/index.js) -- each one reads
        // ytext/awareness from the facet only once, in its constructor,
        // and never again. CodeMirror's compartment diffing keeps a
        // ViewPlugin's existing instance alive across reconfigure()
        // whenever the plugin *reference* is unchanged, which it always
        // is here. Reconfiguring straight from one file's plugin array to
        // another's therefore never reconstructs them -- they keep
        // running against the previous file's now-destroyed Y.Doc
        // forever, silently swallowing every keystroke and cursor update
        // (transact() doesn't check isDestroyed; see the isCurrentSync
        // comment above). Clearing the compartment to empty in its own
        // dispatch first makes the dispatch below see an empty "previous
        // plugins" list, which forces CodeMirror to construct fresh
        // plugin instances bound to this file's ytext/awareness/doc.
        cm.dispatch({
          ...(initialChanges ? { changes: initialChanges } : {}),
          effects: collabCompartment.reconfigure([])
        });

        // Explicit, tracked Y.UndoManager instead of letting yCollab()
        // construct one implicitly (its default keeps a doc.on('afterTransaction')
        // listener alive until the whole Y.Doc is destroyed, which no longer
        // lines up with how often this dance can legitimately run per file --
        // see the "already bound" skip above). Registered on the sync object so
        // disposeSyncSession() destroys it alongside the rest of the teardown.
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
