import { App } from 'obsidian';
import { writeBinaryFile } from '../vaultFs';
import type { SyncTransport } from './syncTransport';

export interface MtimeWinsContext {
  app: App;
  transport: SyncTransport;
  wireRelPath: string;
  vaultRelPath: string;
  localData: ArrayBuffer;
  remoteData: ArrayBuffer;
  localMtime: number;
  remoteMtime: number;
}

/**
 * Overwrites whichever side has the older mtime with the other side's
 * bytes. Only writes the losing side -- the winning side already holds the
 * correct bytes, so rewriting it would be redundant.
 */
export async function resolveByLatestMtime(ctx: MtimeWinsContext): Promise<void> {
  const { app, transport, wireRelPath, vaultRelPath, localData, remoteData, localMtime, remoteMtime } = ctx;
  if (localMtime > remoteMtime) {
    await transport.uploadFile(wireRelPath, localData, localMtime);
  } else {
    await writeBinaryFile(app, vaultRelPath, remoteData, remoteMtime);
  }
}

/** Writes newly merged bytes to both the local vault file and the remote store, under the same mtime on both. */
export async function commitMergedFile(
  app: App,
  transport: SyncTransport,
  wireRelPath: string,
  vaultRelPath: string,
  data: ArrayBuffer,
  mtime: number
): Promise<void> {
  await writeBinaryFile(app, vaultRelPath, data, mtime);
  await transport.uploadFile(wireRelPath, data, mtime);
}
