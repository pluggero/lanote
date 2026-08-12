"""Deletion-record storage: lets a peer that still has a stale local copy of a
file tell "someone else deleted this" apart from "this is a brand-new file",
so the background sync diff doesn't resurrect deleted files. See handle_delete
/ handle_upload in routes/files.py for where these are read and written."""

import json
import time
from pathlib import Path

from app.security.paths import tombstones_path

# Bounds tombstones.json growth; a peer offline longer than this before its
# next sync will miss the tombstone and re-upload its stale copy.
RETENTION_MS = 30 * 24 * 60 * 60 * 1000


def load_tombstones(room_dir: Path) -> dict[str, int]:
    p = tombstones_path(room_dir)
    if not p.is_file():
        return {}
    try:
        data = json.loads(p.read_text())
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {k: int(v) for k, v in data.items() if isinstance(k, str)}


def _save_tombstones(room_dir: Path, tombstones: dict[str, int]) -> None:
    tombstones_path(room_dir).write_text(json.dumps(tombstones))


def record_tombstone(room_dir: Path, rel_path: str, deleted_at_ms: int) -> None:
    tombstones = load_tombstones(room_dir)
    tombstones[rel_path] = deleted_at_ms
    now_ms = int(time.time() * 1000)
    tombstones = {
        path: ts for path, ts in tombstones.items() if now_ms - ts <= RETENTION_MS
    }
    _save_tombstones(room_dir, tombstones)


def clear_tombstone(room_dir: Path, rel_path: str) -> None:
    tombstones = load_tombstones(room_dir)
    if rel_path in tombstones:
        del tombstones[rel_path]
        _save_tombstones(room_dir, tombstones)
