"""Environment-driven configuration and logging setup."""

import logging
import os
import re
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("lanote")

PORT = int(os.environ.get("PORT", 4245))
DB_DIR = Path(os.environ.get("DB_DIR", Path(__file__).parent.parent / "data")).resolve()
ROOMS_DIR = DB_DIR / "rooms"
ROOMS_DIR.mkdir(parents=True, exist_ok=True)

# Generous enough for note attachments (images, PDFs) without being unbounded;
# aiohttp's own default (1MB) is far too small for real vault files.
MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_BYTES", 200 * 1024 * 1024))

# roomId is always an HKDF-derived, base64url-encoded 128-bit value (crypto.ts);
# this also doubles as a filesystem-safe-name check before it ever touches a path.
ROOM_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

AUTH_HANDSHAKE_TIMEOUT = 5.0
WS_MAX_MSG_BYTES = 16 * 1024 * 1024
MAX_PEERS_PER_ROOM = int(os.environ.get("MAX_PEERS_PER_ROOM", 32))
