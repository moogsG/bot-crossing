"""Profile-scoped Bot Crossing API; native Kanban data is strictly read-only."""

from __future__ import annotations

import importlib
import importlib.util
import json
import math
from pathlib import Path
import sys
import time
from typing import Any
from urllib.parse import parse_qs, urlsplit

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from hermes_constants import get_hermes_home


_SUPPORT_NAME = f"{__name__}_support"
_SUPPORT_DIR = Path(__file__).resolve().parent / "bot_crossing"
_SUPPORT_SPEC = importlib.util.spec_from_file_location(
    _SUPPORT_NAME,
    _SUPPORT_DIR / "__init__.py",
    submodule_search_locations=[str(_SUPPORT_DIR)],
)
if _SUPPORT_SPEC is None or _SUPPORT_SPEC.loader is None:
    raise ImportError("cannot load Bot Crossing dashboard support")
_SUPPORT = importlib.util.module_from_spec(_SUPPORT_SPEC)
sys.modules[_SUPPORT_NAME] = _SUPPORT
_SUPPORT_SPEC.loader.exec_module(_SUPPORT)
_RUNTIME = importlib.import_module(f"{_SUPPORT_NAME}.runtime")

ACTOR_EVENT_VOCABULARY = _SUPPORT.ACTOR_EVENT_VOCABULARY
KanbanReader = _SUPPORT.KanbanReader
ProjectReader = _SUPPORT.ProjectReader
read_layout_state = _RUNTIME.read_state
runtime_document = _RUNTIME.runtime_document
runtime_payload = _RUNTIME.runtime_payload
write_layout_state = _RUNTIME.write_state


router = APIRouter()


def _profile_identity(home: Path) -> str:
    """Return a bounded identity for an effective Hermes home, never its path."""
    resolved = home.expanduser().resolve()
    if resolved.parent.name == "profiles" and resolved.name:
        return resolved.name

    default_home = (Path.home() / ".hermes").resolve()
    if resolved == default_home:
        return "default"
    return "custom"


def _readers() -> tuple[Path, KanbanReader, ProjectReader]:
    home = Path(get_hermes_home()).expanduser().resolve()
    return home, KanbanReader(home), ProjectReader(home)


def _scanned_at() -> int:
    return int(time.time() * 1000)


@router.get("/health")
def health() -> dict[str, Any]:
    """Report bounded store diagnostics for the profile selected by the gateway."""
    home, board, project_reader = _readers()
    board_status = board.diagnostic()
    project_status = project_reader.diagnostic()
    return {
        "status": "healthy" if board_status["available"] and project_status["available"] else "degraded",
        "plugin": "bot-crossing",
        "profile": _profile_identity(home),
        "board": board_status,
        "projects": project_status,
    }


@router.get("/bootstrap")
def bootstrap() -> dict[str, Any]:
    """Describe the immutable transport contract consumed by the embedded colony."""
    home, board, project_reader = _readers()
    return {
        "plugin": "bot-crossing",
        "profile": _profile_identity(home),
        "source": "native-kanban",
        "readOnly": True,
        "eventVocabulary": list(ACTOR_EVENT_VOCABULARY),
        "endpoints": {
            "health": "health",
            "projects": "projects",
            "threads": "threads",
            "actors": "actors",
            "events": "events",
            "state": "state",
        },
        "board": board.diagnostic(),
        "projects": project_reader.diagnostic(),
    }


@router.get("/projects")
def projects() -> dict[str, Any]:
    _, _, reader = _readers()
    values, warnings = reader.scan()
    return {"projects": values, "scannedAt": _scanned_at(), "warnings": warnings}


@router.get("/threads")
def threads() -> dict[str, Any]:
    _, reader, _ = _readers()
    values, warnings = reader.scan_threads()
    return {"threads": values, "scannedAt": _scanned_at(), "warnings": warnings}


@router.get("/actors")
def actors() -> dict[str, Any]:
    _, reader, _ = _readers()
    payload = reader.actor_snapshot()
    return {
        **payload,
        "eventVocabulary": list(ACTOR_EVENT_VOCABULARY),
        "scannedAt": _scanned_at(),
    }


@router.get("/events")
def events(since: str = "0") -> Any:
    try:
        numeric = float(since or "0")
        if not math.isfinite(numeric) or not numeric.is_integer() or numeric < 0 or numeric > 9_007_199_254_740_991:
            raise ValueError
        cursor = int(numeric)
    except (TypeError, ValueError):
        return JSONResponse(
            status_code=400,
            content={"error": "since must be a non-negative safe integer"},
        )
    _, reader, _ = _readers()
    payload, warnings = reader.scan_events(cursor)
    return {**payload, "warnings": warnings}


@router.get("/state")
def state() -> dict[str, Any]:
    """Read only Bot Crossing's profile-local presentation state."""
    home, _, _ = _readers()
    return read_layout_state(home)


@router.put("/state")
def put_state(payload: dict[str, Any]) -> Any:
    """Persist Bot Crossing layout state; the native Kanban store is never opened writable."""
    home, _, _ = _readers()
    status, value = write_layout_state(home, payload)
    if status == 409:
        return JSONResponse(status_code=status, content=value)
    return value


@router.get("/runtime")
def runtime() -> Any:
    """Serve the prebuilt colony as an opaque-origin, self-contained frame document."""
    try:
        return runtime_payload()
    except (OSError, RuntimeError, ValueError) as exc:
        return JSONResponse(status_code=503, content={"error": str(exc)})


@router.post("/transport")
def transport(payload: dict[str, Any]) -> dict[str, Any]:
    """Broker the opaque frame through the authenticated, profile-scoped Desktop REST door."""
    method = str(payload.get("method") or "GET").upper()
    parsed = urlsplit(str(payload.get("path") or ""))
    reads = {
        "/api/health": health,
        "/api/bootstrap": bootstrap,
        "/api/projects": projects,
        "/api/threads": threads,
        "/api/actors": actors,
        "/api/state": state,
    }
    if method == "GET" and parsed.path in reads:
        result = reads[parsed.path]()
    elif method == "GET" and parsed.path == "/api/events":
        result = events(parse_qs(parsed.query).get("since", ["0"])[0])
    elif method == "PUT" and parsed.path == "/api/state":
        request_body = payload.get("body")
        result = put_state(request_body if isinstance(request_body, dict) else {})
    else:
        return {"status": 403, "body": {"error": "Bot Crossing request is not allowed"}}

    if isinstance(result, JSONResponse):
        raw_body = getattr(result, "body", None)
        body = json.loads(raw_body) if isinstance(raw_body, bytes) else getattr(result, "content", {})
        return {"status": result.status_code, "body": body}
    return {"status": 200, "body": result}
