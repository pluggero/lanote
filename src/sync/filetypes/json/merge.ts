import { App } from 'obsidian';
import type { SyncTransport } from '../../syncTransport';
import { commitMergedFile, resolveByLatestMtime } from '../../mtimeWins';

// Keys that, if assigned via merged[key] = ... on a plain object, mutate the
// object's prototype instead of setting an own property (`__proto__` goes
// through Object.prototype's accessor; `constructor`/`prototype` reach the
// same object via a different route). source is a remote peer's JSON file,
// so an untrusted key must never reach that assignment.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function deepMerge(target: any, source: any): any {
  if (typeof target !== 'object' || target === null || typeof source !== 'object' || source === null) {
    return source !== undefined ? source : target;
  }
  if (Array.isArray(target) || Array.isArray(source)) {
    return source;
  }
  const merged = { ...target };
  for (const key of Object.keys(source)) {
    if (UNSAFE_KEYS.has(key)) continue;
    if (source[key] instanceof Object && key in target) {
      merged[key] = deepMerge(target[key], source[key]);
    } else {
      merged[key] = source[key];
    }
  }
  return merged;
}

export interface JsonConflictContext {
  app: App;
  transport: SyncTransport;
  wireRelPath: string;
  vaultRelPath: string;
  localBytes: Uint8Array;
  remoteBytes: Uint8Array;
  localData: ArrayBuffer;
  remoteData: ArrayBuffer;
  localMtime: number;
  remoteMtime: number;
}

/** Automatically merges a conflicting JSON config file via a recursive deep-merge, falling back to silent latest-mtime-wins if either side fails to parse as JSON. */
export async function resolveJsonConflict(ctx: JsonConflictContext): Promise<void> {
  const { app, transport, wireRelPath, vaultRelPath, localBytes, remoteBytes, localData, remoteData, localMtime, remoteMtime } = ctx;
  try {
    const decoder = new TextDecoder('utf-8');
    const encoder = new TextEncoder();

    const localJson = JSON.parse(decoder.decode(localBytes));
    const remoteJson = JSON.parse(decoder.decode(remoteBytes));

    const mergedJson = deepMerge(localJson, remoteJson);
    const mergedData = encoder.encode(JSON.stringify(mergedJson, null, 2)).buffer;

    const mergedMtime = Math.max(localMtime, remoteMtime);

    await commitMergedFile(app, transport, wireRelPath, vaultRelPath, mergedData, mergedMtime);
    console.log(`[LANote] Automatically merged JSON conflict for config file: ${wireRelPath}`);
  } catch (jsonErr) {
    console.warn(`[LANote] JSON merge failed for ${wireRelPath}, falling back to silent mtime resolution:`, jsonErr);
    await resolveByLatestMtime({ app, transport, wireRelPath, vaultRelPath, localData, remoteData, localMtime, remoteMtime });
  }
}
