"""Health/status endpoint."""

from aiohttp import web


async def handle_status(_request: web.Request) -> web.Response:
    return web.Response(text="LANote sync server (zero-knowledge relay) is running.")
