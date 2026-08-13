"""Yjs WebSocket relay: dumb binary-frame pub/sub between peers in a room."""

import asyncio

from aiohttp import WSMsgType, web

from app.config import AUTH_HANDSHAKE_TIMEOUT, MAX_PEERS_PER_ROOM, WS_MAX_MSG_BYTES, log
from app.security.auth import check_or_claim_auth
from app.security.paths import room_dir_for

# roomname (the WS path segment) -> set of connected peers for that Yjs doc.
# Purely an in-memory relay group; never inspected or decoded.
room_peers: dict[str, set[web.WebSocketResponse]] = {}


async def handle_ws(request: web.Request) -> web.WebSocketResponse:
    roomname = request.match_info["roomname"]
    room_id = request.query.get("room", "")
    room_dir = room_dir_for(room_id)

    ws = web.WebSocketResponse(max_msg_size=WS_MAX_MSG_BYTES)
    await ws.prepare(request)

    if room_dir is None:
        await ws.close(code=4000, message=b"invalid room")
        return ws

    try:
        first_msg = await asyncio.wait_for(ws.receive(), timeout=AUTH_HANDSHAKE_TIMEOUT)
    except asyncio.TimeoutError:
        await ws.close(code=4001, message=b"auth timeout")
        return ws

    if first_msg.type != WSMsgType.BINARY or not check_or_claim_auth(room_dir, first_msg.data):
        await ws.close(code=4003, message=b"unauthorized")
        return ws

    # roomname (the relay group key) must belong to the authenticated room_id
    # -- otherwise a credential valid for one room could admit its holder into
    # a completely different room's relay group.
    if roomname != room_id and not roomname.startswith(f"{room_id}:"):
        await ws.close(code=4003, message=b"unauthorized")
        return ws

    peers = room_peers.setdefault(roomname, set())
    if len(peers) >= MAX_PEERS_PER_ROOM:
        await ws.close(code=4004, message=b"room full")
        return ws
    peers.add(ws)
    log.info("peer joined room %s (now %d peer(s))", room_id[:8], len(peers))

    try:
        async for msg in ws:
            if msg.type == WSMsgType.BINARY:
                stale = set()
                for peer in peers:
                    if peer is ws or peer.closed:
                        if peer.closed:
                            stale.add(peer)
                        continue
                    try:
                        await peer.send_bytes(msg.data)
                    except ConnectionResetError:
                        stale.add(peer)
                peers.difference_update(stale)
            elif msg.type == WSMsgType.ERROR:
                log.warning("ws connection for room %s closed with exception: %s", room_id[:8], ws.exception())
    finally:
        peers.discard(ws)
        if not peers:
            room_peers.pop(roomname, None)
        log.info("peer left room %s", room_id[:8])

    return ws
