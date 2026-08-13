"""File blob storage endpoints: manifest, upload, download, delete, room delete."""

import base64
import binascii
import os
import shutil
import time

from aiohttp import web

from app.config import log
from app.guards import require_path, require_room_and_auth
from app.security.paths import name_path, room_state_path, safe_rel_path
from app.tombstones import clear_tombstone, load_tombstones, record_tombstone

ENC_NAME_HEADER = "X-LANote-Enc-Name"


ENC_NAME_MIN_BYTES = 28  # 12-byte IV + 16-byte GCM tag; anything shorter can't be a real envelope


def _is_well_formed_b64url(value: str) -> bool:
    try:
        decoded = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
        return len(decoded) >= ENC_NAME_MIN_BYTES
    except (binascii.Error, ValueError):
        return False


async def handle_manifest(request: web.Request) -> web.Response:
    room_dir = require_room_and_auth(request)
    if isinstance(room_dir, web.Response):
        return room_dir
    files_dir = room_dir / "files"
    manifest = {}
    for p in files_dir.rglob("*"):
        if p.is_file():
            rel = p.relative_to(files_dir).as_posix()
            st = p.stat()
            entry = {"size": st.st_size, "mtime": int(st.st_mtime * 1000)}
            np = name_path(room_dir, p.relative_to(files_dir))
            if np is not None and np.is_file():
                entry["encName"] = np.read_text()
            manifest[rel] = entry
    return web.json_response(manifest)


async def handle_upload(request: web.Request) -> web.Response:
    room_dir = require_room_and_auth(request)
    if isinstance(room_dir, web.Response):
        return room_dir
    rel = safe_rel_path(request.query.get("path", ""))
    if rel is None:
        return web.Response(status=400, text="invalid path")
    enc_name = request.headers.get(ENC_NAME_HEADER, "")
    if not enc_name or not _is_well_formed_b64url(enc_name):
        return web.Response(status=400, text=f"missing or malformed {ENC_NAME_HEADER} header")
    full = require_path(request, room_dir, "files")
    if isinstance(full, web.Response):
        return full

    full.parent.mkdir(parents=True, exist_ok=True)
    body = await request.read()
    full.write_bytes(body)

    np = name_path(room_dir, rel)
    if np is None:
        return web.Response(status=400, text="invalid path")
    np.parent.mkdir(parents=True, exist_ok=True)
    np.write_text(enc_name)

    mtime_param = request.query.get("mtime")
    if mtime_param:
        try:
            seconds = int(mtime_param) / 1000
            os.utime(full, (seconds, seconds))
        except (ValueError, OSError):
            pass

    # A live re-upload supersedes any prior deletion record for this path.
    clear_tombstone(room_dir, rel.as_posix())

    return web.Response(status=200, text="Uploaded")


async def handle_download(request: web.Request) -> web.Response:
    room_dir = require_room_and_auth(request)
    if isinstance(room_dir, web.Response):
        return room_dir
    full = require_path(request, room_dir, "files")
    if isinstance(full, web.Response):
        return full
    if not full.is_file():
        return web.Response(status=404, text="not found")
    return web.Response(body=full.read_bytes(), content_type="application/octet-stream")


async def handle_delete(request: web.Request) -> web.Response:
    room_dir = require_room_and_auth(request)
    if isinstance(room_dir, web.Response):
        return room_dir
    rel = safe_rel_path(request.query.get("path", ""))
    if rel is None:
        return web.Response(status=400, text="invalid path")
    full = require_path(request, room_dir, "files")
    if isinstance(full, web.Response):
        return full
    full.unlink(missing_ok=True)
    if (rsp := room_state_path(room_dir, rel)) is not None:
        rsp.unlink(missing_ok=True)
    if (np := name_path(room_dir, rel)) is not None:
        np.unlink(missing_ok=True)

    # Record when this happened (client clock, same convention as upload's
    # ?mtime= param) so peers with a stale local copy can tell "deleted" apart
    # from "never synced" on their next diff instead of resurrecting it.
    mtime_param = request.query.get("mtime")
    try:
        deleted_at_ms = int(mtime_param) if mtime_param else int(time.time() * 1000)
    except ValueError:
        deleted_at_ms = int(time.time() * 1000)
    record_tombstone(room_dir, rel.as_posix(), deleted_at_ms)

    return web.Response(status=200, text="Deleted")


async def handle_tombstones(request: web.Request) -> web.Response:
    room_dir = require_room_and_auth(request)
    if isinstance(room_dir, web.Response):
        return room_dir
    return web.json_response(load_tombstones(room_dir))


async def handle_delete_room(request: web.Request) -> web.Response:
    room_dir = require_room_and_auth(request)
    if isinstance(room_dir, web.Response):
        return room_dir
    shutil.rmtree(room_dir, ignore_errors=True)
    log.info("deleted entire room directory for room %s", request.query.get("room", "")[:8])
    return web.Response(status=200, text="Room deleted")
