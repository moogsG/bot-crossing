"""Self-contained browser runtime and profile-local colony layout persistence."""

from __future__ import annotations

import base64
import json
import mimetypes
import os
from pathlib import Path
import re
import secrets
import threading
import time
from typing import Any


_STATE_VERSION = 2
_WRITE_LOCK = threading.Lock()
_JS_REFERENCE = re.compile(r'<script\b[^>]*\bsrc="(?P<path>[^"]+)"[^>]*></script>')
_CSS_REFERENCE = re.compile(r'<link\b[^>]*\brel="stylesheet"[^>]*\bhref="(?P<path>[^"]+)"[^>]*>')


def _empty_state() -> dict[str, Any]:
    return {
        "version": _STATE_VERSION,
        "archived": [],
        "archivedAt": {},
        "opened": [],
        "plots": {},
        "seen": {},
        "hiddenProjects": [],
        "viewedAt": {},
        "settings": None,
        "updatedAt": 0,
    }


def _mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _sequence(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _clean_state(value: Any) -> dict[str, Any]:
    source = value if isinstance(value, dict) else {}
    return {
        "version": _STATE_VERSION,
        "archived": _sequence(source.get("archived")),
        "archivedAt": _mapping(source.get("archivedAt")),
        "opened": _sequence(source.get("opened")),
        "plots": _mapping(source.get("plots")),
        "seen": _mapping(source.get("seen")),
        "hiddenProjects": [str(item) for item in _sequence(source.get("hiddenProjects")) if str(item)],
        "viewedAt": _mapping(source.get("viewedAt")),
        "settings": source.get("settings") if isinstance(source.get("settings"), dict) else None,
        "updatedAt": int(source.get("updatedAt") or 0),
    }


def _state_path(home: Path) -> Path:
    return home / "bot-crossing" / "colony.json"


def read_state(home: Path) -> dict[str, Any]:
    try:
        return _clean_state(json.loads(_state_path(home).read_text(encoding="utf-8")))
    except (OSError, TypeError, ValueError):
        return _empty_state()


def write_state(home: Path, payload: Any) -> tuple[int, dict[str, Any]]:
    """Atomically save one profile's Bot Crossing-only state with optimistic locking."""
    with _WRITE_LOCK:
        current = read_state(home)
        source = payload if isinstance(payload, dict) else {}
        base = int(source.get("baseUpdatedAt") or 0)
        if base and current["updatedAt"] != base:
            return 409, current

        state = _clean_state(source)
        state["updatedAt"] = max(int(time.time() * 1000), current["updatedAt"] + 1)
        target = _state_path(home)
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(f"{target.name}.{os.getpid()}.{threading.get_ident()}.tmp")
        try:
            temporary.write_text(json.dumps(state, indent=2), encoding="utf-8")
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
        return 200, state


def _default_runtime_root() -> Path:
    packaged = Path(__file__).resolve().parent / "app"
    if packaged.is_dir():
        return packaged
    return Path(__file__).resolve().parents[3] / "dist"


def _asset_data(runtime_root: Path) -> dict[str, str]:
    assets = runtime_root / "assets"
    if not assets.is_dir():
        return {}
    encoded: dict[str, str] = {}
    for path in sorted(item for item in assets.rglob("*") if item.is_file()):
        if path.suffix.lower() in {".css", ".js", ".map", ".md"}:
            continue
        media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if path.suffix.lower() == ".glb":
            media_type = "model/gltf-binary"
        elif path.suffix.lower() == ".hdr":
            media_type = "image/vnd.radiance"
        relative = path.relative_to(assets).as_posix()
        encoded[relative] = f"data:{media_type};base64,{base64.b64encode(path.read_bytes()).decode('ascii')}"
    return encoded


def runtime_document(runtime_root: Path, bootstrap_token: str) -> str:
    """Inline Vite code and bootstrap bridged model assets in an opaque-origin frame."""
    index_path = runtime_root / "index.html"
    try:
        index = index_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise RuntimeError("Bot Crossing runtime is not built; run npm run build first") from exc

    script_match = _JS_REFERENCE.search(index)
    style_match = _CSS_REFERENCE.search(index)
    if script_match is None or style_match is None:
        raise RuntimeError("Bot Crossing runtime index does not contain the expected Vite assets")

    script = (runtime_root / script_match.group("path").lstrip("/")).read_text(encoding="utf-8")
    style = (runtime_root / style_match.group("path").lstrip("/")).read_text(encoding="utf-8")
    bootstrap = f"""
const TOKEN = {json.dumps(bootstrap_token)};
const pending = new Map();
let sequence = 0;
try {{ void localStorage.length; }} catch {{
  const values = new Map();
  Object.defineProperty(globalThis, 'localStorage', {{ value: {{
    getItem: key => values.has(String(key)) ? values.get(String(key)) : null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: key => values.delete(String(key)),
    clear: () => values.clear(),
    key: index => [...values.keys()][index] ?? null,
    get length() {{ return values.size; }},
  }} }});
}}
globalThis.__BOT_CROSSING_TRANSPORT__ = (url, options = {{}}) => new Promise((resolve, reject) => {{
  const id = `${{Date.now().toString(36)}}-${{++sequence}}`;
  const timer = setTimeout(() => {{ pending.delete(id); reject(new Error('Hermes plugin request timed out')); }}, 15000);
  pending.set(id, {{ resolve, reject, timer }});
  parent.postMessage({{
    kind: 'bot-crossing:request', token: TOKEN, id, url: String(url),
    method: String(options.method || 'GET').toUpperCase(),
    headers: options.headers || {{}}, body: options.body ?? null,
  }}, '*');
}});
addEventListener('message', event => {{
  const message = event.data;
  if (event.source !== parent || message?.kind !== 'bot-crossing:response' || message.token !== TOKEN) return;
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  clearTimeout(entry.timer);
  entry.resolve(new Response(JSON.stringify(message.body ?? {{}}), {{
    status: Number(message.status) || 500,
    statusText: String(message.statusText || ''),
    headers: {{ 'Content-Type': 'application/json' }},
  }}));
}});
(async () => {{
  const response = await globalThis.__BOT_CROSSING_TRANSPORT__('/__bot-crossing/assets');
  if (!response.ok) throw new Error('Could not load Bot Crossing model assets');
  globalThis.__BOT_CROSSING_ASSETS__ = (await response.json()).assets || {{}};
  const source = document.querySelector('#bot-crossing-application');
  const application = document.createElement('script');
  application.type = 'module';
  application.textContent = source.textContent;
  source.remove();
  document.body.append(application);
  setTimeout(() => {{ globalThis.__BOT_CROSSING_ASSETS__ = {{}}; }}, 5000);
}})().catch(error => {{
  document.querySelector('#app').textContent = 'Bot Crossing is unavailable — retry from Hermes.';
  console.error(error);
}});
"""
    safe_bootstrap = bootstrap.replace("</script", "<\\/script")
    safe_script = script.replace("</script", "<\\/script")
    return (
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
        "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no\">"
        "<meta name=\"color-scheme\" content=\"dark\"><title>Bot Crossing</title>"
        f"<style>{style}</style></head><body><div id=\"app\"></div>"
        f"<script id=\"bot-crossing-application\" type=\"text/plain\">{safe_script}</script>"
        f"<script>{safe_bootstrap}</script></body></html>"
    )


def runtime_payload(runtime_root: Path | None = None) -> dict[str, Any]:
    root = runtime_root or _default_runtime_root()
    token = secrets.token_urlsafe(24)
    document = runtime_document(root, token)
    encoded = base64.b64encode(document.encode("utf-8")).decode("ascii")
    return {
        "mediaType": "text/html",
        "bootstrapToken": token,
        "src": f"data:text/html;base64,{encoded}",
        "assets": _asset_data(root),
    }
