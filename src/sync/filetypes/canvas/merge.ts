import { App } from 'obsidian';
import * as Y from 'yjs';
import { reconcileYElements } from '../../../lib/reconcile';
import type { SyncTransport } from '../../syncTransport';
import { commitMergedFile, resolveByLatestMtime } from '../../mtimeWins';
import { parseCanvas, serializeCanvas, type CanvasNode, type CanvasEdge, type CanvasData } from './codec';
import { reconcileCanvasEntries, synthesizeEntry, type CanvasVersionedEntry } from './reconcileElements';
import { CanvasIdBaselineStore, knownIdsOf } from './idBaseline';

export interface CanvasConflictContext {
  app: App;
  transport: SyncTransport;
  wireRelPath: string;
  vaultRelPath: string;
  localData: ArrayBuffer;
  remoteData: ArrayBuffer;
  localMtime: number;
  remoteMtime: number;
  canvasIds: CanvasIdBaselineStore;
}

/**
 * Merges a conflicting canvas board at the node/edge level: fetches the
 * board's CRDT snapshot, reconciles local's nodes/edges into it via
 * reconcileCanvasEntries (synthetic versioning, see reconcileElements.ts),
 * and writes the merged board back. Mirrors resolveExcalidrawConflict's
 * structure; falls back to latest-mtime-wins on any parse/merge failure.
 */
export async function resolveCanvasConflict(ctx: CanvasConflictContext): Promise<void> {
  const { app, transport, wireRelPath, vaultRelPath, localData, remoteData, localMtime, remoteMtime, canvasIds } = ctx;
  try {
    const decoder = new TextDecoder('utf-8');
    const local = parseCanvas(decoder.decode(localData));
    const remote = parseCanvas(decoder.decode(remoteData));
    if (!local || !remote) throw new Error(`local or remote copy of ${wireRelPath} did not parse as a .canvas file`);

    // Nodes and edges get separate Y.Maps: JSON Canvas doesn't guarantee their id spaces are disjoint.
    const doc = new Y.Doc();
    const snapshot = await transport.getRoomStateSnapshot(wireRelPath);
    if (snapshot) Y.applyUpdate(doc, snapshot);
    const yNodes = doc.getMap<CanvasVersionedEntry<CanvasNode>>('nodes');
    const yEdges = doc.getMap<CanvasVersionedEntry<CanvasEdge>>('edges');

    // First-ever conflict: seed both Y.Maps from remote before folding in local edits.
    if (yNodes.size === 0 && yEdges.size === 0) {
      doc.transact(() => {
        for (const node of remote.nodes) yNodes.set(node.id, synthesizeEntry(node.id, undefined, node));
        for (const edge of remote.edges) yEdges.set(edge.id, synthesizeEntry(edge.id, undefined, edge));
      });
    }

    const localKnownIds = canvasIds.get(wireRelPath);
    const knownNodeIds = new Set(localKnownIds?.nodeIds ?? []);
    const knownEdgeIds = new Set(localKnownIds?.edgeIds ?? []);

    const mergedNodeEntries = reconcileCanvasEntries(yNodes, local.nodes, knownNodeIds);
    const mergedEdgeEntries = reconcileCanvasEntries(yEdges, local.edges, knownEdgeIds);
    reconcileYElements(yNodes, mergedNodeEntries);
    reconcileYElements(yEdges, mergedEdgeEntries);

    const mergedUpdate = Y.encodeStateAsUpdate(doc);
    await transport.putRoomStateSnapshot(wireRelPath, mergedUpdate);

    // Top-level fields beyond nodes/edges come from whichever side was edited more recently.
    const newerSide: CanvasData = localMtime >= remoteMtime ? local : remote;
    const mergedData: CanvasData = {
      ...newerSide,
      nodes: mergedNodeEntries.filter((e): e is typeof e & { value: CanvasNode } => e.value !== null).map(e => e.value),
      edges: mergedEdgeEntries.filter((e): e is typeof e & { value: CanvasEdge } => e.value !== null).map(e => e.value),
    };

    canvasIds.set(wireRelPath, knownIdsOf(mergedData));

    const encoder = new TextEncoder();
    const mergedBytes = encoder.encode(serializeCanvas(mergedData)).buffer;
    const mergedMtime = Date.now();
    await commitMergedFile(app, transport, wireRelPath, vaultRelPath, mergedBytes, mergedMtime);
    console.log(`[LANote] Element-level merge successful for canvas: ${wireRelPath}`);
  } catch (mergeErr) {
    console.error(`[LANote] Canvas merge failed for ${wireRelPath}, falling back to silent mtime resolution:`, mergeErr);
    await resolveByLatestMtime({ app, transport, wireRelPath, vaultRelPath, localData, remoteData, localMtime, remoteMtime });
  }
}
