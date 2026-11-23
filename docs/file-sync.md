# Supported file types

[← Back to README](../README.md)

- **Markdown (`.md`, excluding Excalidraw drawings)** — live, real-time collaborative text editing while the note is open (character-level Yjs CRDT), and that same CRDT history auto-merges background/offline conflicts too. Falls back to keeping whichever copy has the newer modification time only if the CRDT merge itself errors.
- **Excalidraw drawings (`*.excalidraw.md`)** — merged at the scene-element level in the background/periodic sync (not live while open): each element is kept or replaced by id, with the higher edit version winning and a random per-edit tiebreaker for exact ties, so concurrent edits to different shapes combine instead of corrupting the file, and a deleted element can't be resurrected by an unrelated concurrent edit. Embedded image attachments from both copies are kept; other file-level state (viewport, selected tool, frontmatter) is taken wholly from whichever copy was edited more recently. Falls back to newest-mtime-wins for the whole file if either copy isn't a well-formed Excalidraw file.

  LANote detects changes by polling the file's on-disk modification time, not by watching Excalidraw's in-memory canvas state. The Excalidraw plugin autosaves on a debounce, so an edit can sit unwritten for a while; pressing **Ctrl+S** (Cmd+S on macOS) inside the Excalidraw window forces an immediate write and gets that edit into the next sync tick sooner.
- **JSON (`.json`)** — recursively merged key-by-key in the background/periodic sync: shared object keys are combined, but the other device's value wins wherever a key isn't itself a further mergeable object — including whole arrays, which are replaced rather than combined. Falls back to newest-mtime-wins for the whole file if either copy fails to parse as JSON.
- **Everything else** — no merge logic. Conflicts are resolved silently by keeping whichever copy has the newer modification time; the other device's changes to that file are discarded.

## Deletions

Local deletes are pushed to all peers a few seconds after the last one.

Once deletes add up to at least 3 files and half the shared folder, LANote asks immediately:

- **On the device that deleted:** *Push this deletion* or *Restore my files* (this device only, nothing was sent yet).
- **On the other peers:** *Delete here too* or *Undo for everyone* (restores the files on every peer).

Closing the dialog picks the restore / undo option. Moved or renamed files don't count as deleted.

Limits: deletes more than 3 seconds apart are not grouped; quitting Obsidian right after deleting can drop queued deletes; deletion records expire after 30 days.
