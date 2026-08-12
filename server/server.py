#!/usr/bin/env python3
"""LANote sync server: a zero-knowledge relay + opaque blob store.

Every file, room-state snapshot, and live sync/awareness frame this server
touches is AEAD ciphertext produced client-side (see crypto.ts) — this
process never has the room secret, the encryption key, or any plaintext.
It only ever needs to (a) store/return byte blobs by room + relative path,
and (b) relay WebSocket frames verbatim between peers who share a room.

Because of (b), this server does NOT run Yjs and does not maintain a
server-side CRDT document; two connected clients complete the real Yjs sync
protocol directly with each other, with this process acting as a dumb pipe
(the same pattern y-webrtc uses for serverless peer-to-peer sync). Durable
persistence for offline/async collaborators is handled by the client
periodically POSTing an encrypted CRDT snapshot to /api/room-state; see the
LANote design plan for the full rationale.

See app/ for the actual implementation, organized by concern:
config, security/ (path + auth primitives), guards, middleware, routes/.
"""

from aiohttp import web

from app.config import DB_DIR, PORT, log
from app.factory import build_app

if __name__ == "__main__":
    log.info("=" * 55)
    log.info("  LANOTE ZERO-KNOWLEDGE SYNC SERVER")
    log.info("=" * 55)
    log.info("Port: %s", PORT)
    log.info("Database directory: %s", DB_DIR)
    log.info("Listening on: 0.0.0.0:%s", PORT)
    # access_log=None: aiohttp's built-in per-request logger prints the full,
    # untruncated query string (room id and all) -- sanitized_logging_middleware
    # above is our only request log, so the built-in one must stay off.
    web.run_app(build_app(), host="0.0.0.0", port=PORT, print=None, access_log=None)
