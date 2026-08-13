import { App } from 'obsidian';

async function mkdirIfMissing(app: App, dir: string, swallowErrors: boolean): Promise<void> {
  if (await app.vault.adapter.exists(dir)) return;
  if (swallowErrors) {
    await app.vault.adapter.mkdir(dir).catch(() => {});
  } else {
    await app.vault.adapter.mkdir(dir);
  }
}

/**
 * Creates a vault folder and any missing parent segments, one at a time.
 * Used when joining a room to a not-yet-existing destination folder --
 * mirrors the per-segment walk in ensureParentDirsExist below rather than relying
 * on Vault.createFolder's own parent-creation behavior.
 */
export async function ensureFolderExists(app: App, folderPath: string): Promise<void> {
  const parts = folderPath.replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean);
  let cur = '';
  for (const part of parts) {
    cur = cur ? `${cur}/${part}` : part;
    await mkdirIfMissing(app, cur, false);
  }
}

/**
 * Ensures the parent directories of a vault-relative file path exist,
 * creating any that are missing. Used before writing a file downloaded from
 * the server, which may land in a directory that doesn't exist locally yet.
 */
export async function ensureParentDirsExist(app: App, relPath: string): Promise<void> {
  const parts = relPath.replace(/\\/g, '/').split('/');
  let cur = '';
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i] as string;
    cur = cur ? `${cur}/${part}` : part;
    await mkdirIfMissing(app, cur, true);
  }
}

/**
 * Writes binary data directly to the Obsidian vault using low-level adapter APIs
 * to bypass standard hidden-file limitations of app.vault.
 */
export async function writeBinaryFile(app: App, relPath: string, data: ArrayBuffer): Promise<void> {
  await app.vault.adapter.writeBinary(relPath, data);
}

/** Rewrites a file with its own content but a fresh mtime -- a plain rename doesn't update mtime on its own. */
export async function touchFileMtime(app: App, relPath: string): Promise<void> {
  const data = await app.vault.adapter.readBinary(relPath);
  await app.vault.adapter.writeBinary(relPath, data, { mtime: Date.now() });
}

/**
 * Removes a file via the Vault API (trash, not the raw adapter) so Obsidian's
 * file index/UI update immediately and the removal is recoverable from trash.
 * Used when a background sync determines a local file is a stale leftover of
 * a deletion that already happened elsewhere in the room.
 */
export async function deleteLocalFile(app: App, relPath: string): Promise<void> {
  const file = app.vault.getAbstractFileByPath(relPath);
  if (file) await app.vault.trash(file, true);
}
