"""Shared type aliases."""

from pathlib import Path
from typing import TypeAlias

from aiohttp import web

# Guard helpers either return the validated Path the caller asked for, or an
# error web.Response to return immediately -- callers check with isinstance().
GuardResult: TypeAlias = Path | web.Response
