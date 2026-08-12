import { App } from 'obsidian';
import { writeBinaryFile } from '../vaultFs';
import type { SyncTransport } from './syncTransport';

function deepMerge(target: any, source: any): any {
  if (typeof target !== 'object' || target === null || typeof source !== 'object' || source === null) {
    return source !== undefined ? source : target;
  }
  if (Array.isArray(target) || Array.isArray(source)) {
    return source;
  }
  const merged = { ...target };
  for (const key of Object.keys(source)) {
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

    // Save merged file locally and upload to remote
    await writeBinaryFile(app, vaultRelPath, mergedData);
    await transport.uploadFile(wireRelPath, mergedData, mergedMtime);
    console.log(`[LANote] Automatically merged JSON conflict for config file: ${wireRelPath}`);
  } catch (jsonErr) {
    console.warn(`[LANote] JSON merge failed for ${wireRelPath}, falling back to silent mtime resolution:`, jsonErr);
    // Fallback: Silent latest modified wins (Zero Conflicts Protocol!)
    if (localMtime > remoteMtime) {
      await transport.uploadFile(wireRelPath, localData, localMtime);
    } else {
      await writeBinaryFile(app, vaultRelPath, remoteData);
    }
  }
}
