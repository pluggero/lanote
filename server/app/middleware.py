"""Cross-cutting request middleware: sanitized logging and CORS."""

from aiohttp import web

from app.config import log


@web.middleware
async def sanitized_logging_middleware(request: web.Request, handler):
    response = await handler(request)
    room = request.query.get("room", request.match_info.get("roomname", ""))
    log.info("%s %s (room=%s...) -> %s", request.method, request.path, room[:8], response.status)
    return response


@web.middleware
async def cors_middleware(request: web.Request, handler):
    if request.method == "OPTIONS":
        response = web.Response(status=200)
    else:
        response = await handler(request)
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
    return response
