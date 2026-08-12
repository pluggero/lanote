"""App assembly: middleware wiring + route registration."""

from aiohttp import web

from app.config import MAX_UPLOAD_BYTES
from app.middleware import cors_middleware, sanitized_logging_middleware
from app.routes import register_routes


def build_app() -> web.Application:
    app = web.Application(client_max_size=MAX_UPLOAD_BYTES, middlewares=[cors_middleware, sanitized_logging_middleware])
    register_routes(app)
    return app
