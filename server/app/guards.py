"""Request-parsing glue shared by every file/room-state handler."""

from pathlib import Path

from aiohttp import web

from app.security.auth import check_or_claim_auth, decode_bearer_token
from app.security.paths import resolve_within, room_dir_for, safe_rel_path
from app.types import GuardResult


def require_room_and_auth(request: web.Request) -> GuardResult:
    room_id = request.query.get("room", "")
    room_dir = room_dir_for(room_id)
    if room_dir is None:
        return web.Response(status=400, text="invalid room")
    if not check_or_claim_auth(room_dir, decode_bearer_token(request)):
        return web.Response(status=401, text="unauthorized")
    return room_dir


def require_path(request: web.Request, room_dir: Path, files_subdir: str) -> GuardResult:
    rel = safe_rel_path(request.query.get("path", ""))
    if rel is None:
        return web.Response(status=400, text="invalid path")
    full = resolve_within(room_dir / files_subdir, rel)
    if full is None:
        return web.Response(status=400, text="invalid path")
    return full
