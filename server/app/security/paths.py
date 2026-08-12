"""Filesystem path-safety primitives: room directory layout and traversal defense."""

import base64
from pathlib import Path

from app.config import ROOMS_DIR, ROOM_ID_RE


def room_dir_for(room_id: str) -> Path | None:
    if not ROOM_ID_RE.match(room_id):
        return None
    d = ROOMS_DIR / room_id
    (d / "files").mkdir(parents=True, exist_ok=True)
    (d / "roomstate").mkdir(parents=True, exist_ok=True)
    return d


def safe_rel_path(rel_path: str) -> Path | None:
    """Rejects absolute paths, empty segments, and `..` traversal."""
    if not rel_path:
        return None
    normalized = rel_path.replace("\\", "/")
    if normalized.startswith("/"):
        return None
    parts = normalized.split("/")
    if any(part in ("", "..", ".") for part in parts):
        return None
    return Path(*parts)


def resolve_within(base: Path, rel: Path) -> Path | None:
    """Defense in depth beyond safe_rel_path: confirms the resolved path
    is still actually inside `base` (catches odd filesystem edge cases,
    not just string-level `..`)."""
    full = (base / rel).resolve()
    try:
        full.relative_to(base.resolve())
    except ValueError:
        return None
    return full


def verifier_path(room_dir: Path) -> Path:
    return room_dir / ".authverifier"


def room_state_path(room_dir: Path, rel: Path) -> Path:
    safe_name = base64.urlsafe_b64encode(rel.as_posix().encode()).decode().rstrip("=")
    return room_dir / "roomstate" / f"{safe_name}.bin"
