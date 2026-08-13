"""Filesystem path-safety primitives: room directory layout and traversal defense."""

from pathlib import Path

from app.config import ROOMS_DIR, ROOM_ID_RE


def room_dir_for(room_id: str) -> Path | None:
    if not ROOM_ID_RE.match(room_id):
        return None
    d = ROOMS_DIR / room_id
    (d / "files").mkdir(parents=True, exist_ok=True)
    (d / "roomstate").mkdir(parents=True, exist_ok=True)
    (d / "names").mkdir(parents=True, exist_ok=True)
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


def room_state_path(room_dir: Path, rel: Path) -> Path | None:
    # rel is already an opaque, filesystem-safe path token (see crypto.ts
    # derivePathToken) -- no need to re-encode it as this used to when rel
    # was a plaintext, possibly-nested relative path.
    return resolve_within(room_dir / "roomstate", Path(f"{rel.as_posix()}.bin"))


def name_path(room_dir: Path, rel: Path) -> Path | None:
    """Sidecar storing a file's encrypted display name, keyed by the same
    path token as its content under files/. Kept in its own directory
    (rather than alongside files/) so handle_manifest's rglob over files/
    doesn't need to filter it out."""
    return resolve_within(room_dir / "names", rel)


def tombstones_path(room_dir: Path) -> Path:
    """Deliberately outside files/ and roomstate/ so it's never picked up by
    the manifest's rglob or treated as a syncable file."""
    return room_dir / "tombstones.json"
