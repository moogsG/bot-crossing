"""Profile-scoped read-only API for the unified Bot Crossing plugin."""

from __future__ import annotations

import importlib.util
import math
from pathlib import Path
import sys
import time
from typing import Any

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

ACTOR_EVENT_VOCABULARY = _SUPPORT.ACTOR_EVENT_VOCABULARY
KanbanReader = _SUPPORT.KanbanReader
ProjectReader = _SUPPORT.ProjectReader


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
