"""Encrypted CRDT room-state snapshot endpoints."""

from aiohttp import web

from app.config import log
from app.guards import require_room_and_auth
from app.security.paths import room_state_path, safe_rel_path


async def handle_room_state_get(request: web.Request) -> web.Response:
    room_dir = require_room_and_auth(request)
    if isinstance(room_dir, web.Response):
        return room_dir
    rel = safe_rel_path(request.query.get("path", ""))
    if rel is None:
        return web.Response(status=400, text="invalid path")
    p = room_state_path(room_dir, rel)
    if not p.is_file():
        # Genuinely empty body means "no snapshot yet" -- unambiguous, since
        # real AES-GCM ciphertext (IV + tag alone) is never 0 bytes.
        return web.Response(status=200, body=b"")
    return web.Response(body=p.read_bytes(), content_type="application/octet-stream")


async def handle_room_state_post(request: web.Request) -> web.Response:
    room_dir = require_room_and_auth(request)
    if isinstance(room_dir, web.Response):
        return room_dir
    rel = safe_rel_path(request.query.get("path", ""))
    if rel is None:
        return web.Response(status=400, text="invalid path")
    body = await request.read()
    room_state_path(room_dir, rel).write_bytes(body)
    return web.Response(status=200, text="Stored")


async def handle_reconstruct(request: web.Request) -> web.Response:
    room_dir = require_room_and_auth(request)
    if isinstance(room_dir, web.Response):
        return room_dir
    roomstate_dir = room_dir / "roomstate"
    count = 0
    for p in roomstate_dir.glob("*.bin"):
        p.unlink(missing_ok=True)
        count += 1
    log.info("reconstruct-db: cleared %d room-state snapshot(s) for room %s", count, request.query.get("room"))
    return web.json_response({"success": True, "message": f"Cleared {count} room-state snapshot(s) for this room."})
