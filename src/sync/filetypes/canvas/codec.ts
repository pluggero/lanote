import type { CanvasData, AllCanvasNodeData, CanvasEdgeData } from 'obsidian/canvas';

export type { CanvasData };
export type CanvasNode = AllCanvasNodeData;
export type CanvasEdge = CanvasEdgeData;

/**
 * Parses a `.canvas` file's raw text. Returns null (never throws) on
 * invalid JSON or a missing `nodes`/`edges` array -- callers must fall back
 * to a different resolution, not treat this as fatal. Individual node/edge
 * objects are trusted as-is; the JSON Canvas spec allows unknown fields.
 */
export function parseCanvas(text: string): CanvasData | null {
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
    return null;
  }
  return parsed as CanvasData;
}

/** Inverse of parseCanvas. Tab-indented to match Obsidian's own writer -- cosmetic only. */
export function serializeCanvas(data: CanvasData): string {
  return JSON.stringify(data, null, '\t');
}
