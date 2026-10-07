"""Bot Crossing dashboard and Hermes Desktop contribution."""

from __future__ import annotations

import logging

_log = logging.getLogger("hermes.plugins.bot-crossing")


def register(ctx) -> None:
    """Register the package so Hermes can mount its dashboard surface."""
    _log.info("bot-crossing: dashboard API and Desktop contribution available")
