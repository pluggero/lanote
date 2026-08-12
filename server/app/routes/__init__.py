"""Route registration: wires all endpoints onto an aiohttp app."""

from aiohttp import web

from app.routes.files import (
    handle_delete,
    handle_delete_room,
    handle_download,
    handle_manifest,
    handle_upload,
)
from app.routes.room_state import (
    handle_reconstruct,
    handle_room_state_get,
    handle_room_state_post,
)
from app.routes.status import handle_status
from app.routes.websocket import handle_ws


def register_routes(app: web.Application) -> None:
    app.router.add_get("/", handle_status)
    app.router.add_get("/api/manifest", handle_manifest)
    app.router.add_post("/api/upload", handle_upload)
    app.router.add_get("/api/download", handle_download)
    app.router.add_delete("/api/delete", handle_delete)
    app.router.add_delete("/api/room", handle_delete_room)
    app.router.add_get("/api/room-state", handle_room_state_get)
    app.router.add_post("/api/room-state", handle_room_state_post)
    app.router.add_post("/api/reconstruct-db", handle_reconstruct)
    app.router.add_route("OPTIONS", "/{tail:.*}", lambda r: web.Response(status=200))
    # Catch-all, registered last: any other path is a Yjs WebsocketProvider
    # connection, whose roomname is `serverUrl + '/' + roomname` per y-websocket.
    app.router.add_get("/{roomname:.+}", handle_ws)
