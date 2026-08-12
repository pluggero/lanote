import { App, Notice, TFile } from 'obsidian';
import * as diff from 'diff';

export async function cleanupAndMergeConflicts(app: App): Promise<void> {
  const files = app.vault.getFiles();
  let mergedCount = 0;

  for (const file of files) {
    const match = file.name.match(/^(.*?) \(Conflict from .*\)\.md$/);
    if (match) {
      const baseName = match[1] + '.md';
      const basePath = file.path.replace(file.name, baseName);
      const baseFile = app.vault.getAbstractFileByPath(basePath);

      if (baseFile instanceof TFile) {
        const baseContent = await app.vault.read(baseFile);
        const conflictContent = await app.vault.read(file);

        if (baseContent === conflictContent) {
          // Identical, just delete the conflict file
          await app.vault.trash(file, true);
          mergedCount++;
          continue;
        }

        // Automatic CRDT-style additive merge (no git markers)
        const diffs = diff.diffWordsWithSpace(baseContent, conflictContent);
        let mergedContent = "";
        for (const part of diffs) {
          // Keep all text from both versions (CRDT union behavior)
          mergedContent += part.value;
        }

        await app.vault.modify(baseFile, mergedContent);
        await app.vault.trash(file, true);
        mergedCount++;
      }
    }
  }

  new Notice(`Merged and cleaned up ${mergedCount} conflict files!`);
}
