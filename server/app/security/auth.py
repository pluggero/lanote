"""Bearer/WS token decoding and trust-on-first-use room auth."""

import base64
import hashlib
import hmac
from pathlib import Path

from aiohttp import web

from app.security.paths import verifier_path


def decode_bearer_token(request: web.Request) -> bytes | None:
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        return None
    token_b64 = header[len("Bearer "):].strip()
    return decode_base64url_token(token_b64)


def decode_base64url_token(token_b64: str) -> bytes | None:
    try:
        padded = token_b64 + "=" * (-len(token_b64) % 4)
        return base64.urlsafe_b64decode(padded)
    except Exception:
        return None


def check_or_claim_auth(room_dir: Path, token: bytes | None) -> bool:
    """Trust-on-first-use: whoever presents a token for this room first
    defines the room's credential; everyone after must match it via a
    constant-time comparison. Simultaneous first contact from two peers
    is an accepted, low-probability race on a LAN a single operator sets
    up — not hardened against a hostile multi-tenant server."""
    if not token:
        return False
    digest = hashlib.sha256(token).digest()
    vpath = verifier_path(room_dir)
    if vpath.exists():
        return hmac.compare_digest(vpath.read_bytes(), digest)
    vpath.write_bytes(digest)
    return True
