"""Read-only diagnostics for the unified Bot Crossing plugin."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter
from hermes_constants import get_hermes_home


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


@router.get("/health")
def health() -> dict[str, str]:
    """Report plugin readiness for the profile selected by the gateway."""
    return {
        "status": "healthy",
        "plugin": "bot-crossing",
        "profile": _profile_identity(get_hermes_home()),
    }
