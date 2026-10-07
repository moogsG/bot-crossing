"""Read-only projection of an effective Hermes home's native Kanban board."""

from __future__ import annotations

import json
import sqlite3
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable

from .projects import ProjectReader

VISIBLE_STATUSES = ("ready", "running", "review", "blocked")
ACTOR_PROFILES = {"builder", "reviewer", "drone"}
ACTIVE_RUN_STATUSES = {"running", "blocked", "review", "review_requested"}
FRESH_HEARTBEAT_MS = 2 * 60 * 1000
ACTOR_EVENT_VOCABULARY = (
    "claimed",
    "heartbeat",
    "blocked",
    "review_requested",
    "changes_requested",
    "completed",
    "archived",
    "crashed",
    "timed_out",
    "spawn_failed",
    "gave_up",
    "reclaimed",
    "review_reopened",
)
_REQUIRED_COLUMNS = {
    "tasks": {
        "id", "title", "body", "assignee", "status", "created_at", "started_at",
        "workspace_kind", "workspace_path", "branch_name", "project_id", "tenant",
        "current_run_id", "block_kind", "last_heartbeat_at", "session_id",
    },
    "task_runs": {"id", "task_id", "profile", "status", "started_at", "last_heartbeat_at"},
    "task_events": {"id", "task_id", "run_id", "kind", "payload", "created_at"},
}


def _epoch_milliseconds(value: Any) -> int:
    try:
        return int(value or 0) * 1000
    except (TypeError, ValueError):
        return 0


def _attention(status: str, block_kind: str) -> dict[str, Any]:
    if status == "review":
        return {"attention": "review", "attentionLabel": "In review", "requiresMorgan": False}
    if status not in {"blocked", "triage"}:
        return {"attention": "none", "attentionLabel": "", "requiresMorgan": False}
    if block_kind in {"needs_input", "capability"}:
        return {"attention": block_kind, "attentionLabel": "Requires Morgan", "requiresMorgan": True}
    if block_kind in {"dependency", "transient"}:
        return {"attention": block_kind, "attentionLabel": "Internal wait", "requiresMorgan": False}
    return {"attention": "blocked", "attentionLabel": "Blocked", "requiresMorgan": False}


def _diagnostic(error: BaseException | None = None, *, absent: bool = False) -> dict[str, Any]:
    if absent:
        return {"available": False, "code": "absent", "message": "Native Kanban board is not available"}
    text = str(error or "").lower()
    if "locked" in text or "busy" in text:
        code, message = "locked", "Native Kanban board is temporarily busy"
    elif isinstance(error, sqlite3.DatabaseError):
        code, message = "incompatible", "Native Kanban schema is not compatible"
    else:
        code, message = "unavailable", "Native Kanban board could not be read"
    return {"available": False, "code": code, "message": message}


def _repository(workspace: str, fallback: str) -> dict[str, str]:
    if not workspace:
        return {"repositoryId": f"metadata:{fallback or 'Other'}", "repositoryPath": ""}
    canonical = str(Path(workspace).expanduser().resolve())
    try:
        result = subprocess.run(
            [
                "git", "-C", canonical, "rev-parse", "--path-format=absolute",
                "--show-toplevel", "--git-common-dir",
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=1.5,
        )
        output = result.stdout[: 64 * 1024].strip().splitlines()
        if len(output) < 2:
            raise ValueError("incomplete Git identity")
        top_level, common_directory = output[:2]
        repository_path = str(Path(common_directory).parent) if Path(common_directory).name == ".git" else top_level
        return {
            "repositoryId": f"git:{common_directory.replace(chr(92), '/')}",
            "repositoryPath": repository_path.replace(chr(92), "/"),
        }
    except (OSError, subprocess.SubprocessError, ValueError):
        normalized = canonical.replace(chr(92), "/")
        return {"repositoryId": f"workspace:{normalized}", "repositoryPath": normalized}


class KanbanReader:
    """Project native Kanban truth without opening SQLite in write mode."""

    def __init__(self, home: Path, now: Callable[[], int] | None = None):
        self.home = home.expanduser().resolve()
        self.root = self.home.parent.parent if self.home.parent.name == "profiles" else self.home
        self.now = now or (lambda: int(time.time() * 1000))
        candidates = (
            self.root / "kanban" / "boards" / "native" / "kanban.db",
            self.root / "kanban.db",
        )
        self.database = next((path for path in candidates if path.is_file()), candidates[0])
        self.project_reader = ProjectReader(self.home)

    def _connect(self) -> sqlite3.Connection:
        if not self.database.is_file():
            raise FileNotFoundError(self.database)
        connection = sqlite3.connect(
            f"{self.database.resolve().as_uri()}?mode=ro",
            uri=True,
            timeout=0.15,
        )
        connection.row_factory = sqlite3.Row
        try:
            connection.execute("PRAGMA query_only = ON")
            connection.execute("PRAGMA busy_timeout = 150")
            for table, required in _REQUIRED_COLUMNS.items():
                columns = {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}
                if not required.issubset(columns):
                    raise sqlite3.DatabaseError(f"incompatible {table} schema")
        except BaseException:
            connection.close()
            raise
        return connection

    def diagnostic(self) -> dict[str, Any]:
        try:
            connection = self._connect()
            connection.close()
            return {"available": True, "code": "ok", "message": "Native Kanban board is readable"}
        except FileNotFoundError:
            return _diagnostic(absent=True)
        except (OSError, sqlite3.Error) as error:
            return _diagnostic(error)

    def _read(self, operation: Callable[[sqlite3.Connection], Any], empty: Any) -> tuple[Any, list[dict[str, Any]]]:
        try:
            connection = self._connect()
            try:
                return operation(connection), []
            finally:
                connection.close()
        except FileNotFoundError:
            return empty, [_diagnostic(absent=True)]
        except (OSError, sqlite3.Error) as error:
            return empty, [_diagnostic(error)]

    @staticmethod
    def _task_rows(connection: sqlite3.Connection) -> list[sqlite3.Row]:
        return connection.execute(
            """
            SELECT
              t.id, t.title, t.body, t.status, t.block_kind, t.assignee, t.created_at,
              t.started_at, t.workspace_kind, t.project_id, t.tenant, t.workspace_path,
              t.branch_name, t.last_heartbeat_at, t.session_id,
              r.profile AS run_profile, r.status AS run_status, r.started_at AS run_started_at,
              r.last_heartbeat_at AS run_last_heartbeat_at
            FROM tasks t
            LEFT JOIN task_runs r ON r.id = t.current_run_id AND r.task_id = t.id
            WHERE t.status IN ('ready', 'running', 'review', 'blocked')
               OR (t.status = 'triage' AND t.block_kind IN ('needs_input', 'capability'))
            ORDER BY t.id
            """
        ).fetchall()

    def scan_threads(self) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        rows, warnings = self._read(self._task_rows, [])
        if warnings:
            return [], warnings
        catalog, _project_warnings = self.project_reader.scan()
        identities: dict[tuple[str, str], dict[str, str]] = {}
        unique: list[tuple[str, str]] = []
        for row in rows:
            workspace = str(row["workspace_path"] or "")
            workspace_name = Path(workspace).name if workspace else ""
            project = str(row["project_id"] or row["tenant"] or workspace_name or "Other")
            key = (workspace, project)
            if key not in identities:
                identities[key] = {}
                unique.append(key)
        with ThreadPoolExecutor(max_workers=4) as executor:
            resolved = executor.map(lambda item: _repository(*item), unique)
            for key, repository in zip(unique, resolved):
                identities[key] = repository

        threads = []
        for row in rows:
            task_id = str(row["id"])
            body = str(row["body"] or "")
            workspace = str(row["workspace_path"] or "")
            workspace_name = Path(workspace).name if workspace else ""
            project = str(row["project_id"] or row["tenant"] or workspace_name or "Other")
            repository = identities[(workspace, project)]
            explicit = str(row["project_id"] or "")
            known = next(
                (
                    candidate for candidate in catalog
                    if (explicit and explicit in {candidate["id"], candidate["slug"]})
                    or (repository["repositoryPath"] and candidate["path"] == repository["repositoryPath"])
                ),
                None,
            )
            repository_name = Path(repository["repositoryPath"]).name if repository["repositoryPath"] else ""
            project_slug = (known or {}).get("slug") or repository_name or project or "Other"
            project_id = (known or {}).get("id") or explicit
            heartbeat = max(
                _epoch_milliseconds(row["run_last_heartbeat_at"]),
                _epoch_milliseconds(row["last_heartbeat_at"]),
            )
            attention = _attention(str(row["status"]), str(row["block_kind"] or ""))
            threads.append(
                {
                    "id": f"hermes-kanban:{task_id}",
                    "title": str(row["title"] or "Untitled task"),
                    "preview": " ".join(body.split())[:240],
                    "project": project_slug,
                    "projectId": project_id,
                    "tenant": str(row["tenant"] or ""),
                    "projectPath": workspace,
                    **repository,
                    "worktree": workspace_name if row["workspace_kind"] == "worktree" else "",
                    "cwd": workspace,
                    "gitBranch": str(row["branch_name"] or ""),
                    "model": str(row["run_profile"] or row["assignee"] or ""),
                    "effort": "",
                    "createdAt": _epoch_milliseconds(row["created_at"]),
                    "lastActivityAt": max(
                        heartbeat,
                        _epoch_milliseconds(row["run_started_at"]),
                        _epoch_milliseconds(row["started_at"]),
                        _epoch_milliseconds(row["created_at"]),
                    ),
                    "lastFocusedAt": 0,
                    "running": row["status"] == "running",
                    "unread": False,
                    "hasError": row["status"] == "blocked" or attention["requiresMorgan"],
                    "starred": False,
                    "routine": "",
                    "prState": "",
                    "archived": False,
                    "sizeBytes": len(body.encode()),
                    "source": "native-kanban",
                    "canOpen": False,
                    "canArchive": False,
                    "requiresMorgan": attention["requiresMorgan"],
                    "attentionLabel": attention["attentionLabel"],
                    "details": {
                        "taskId": task_id,
                        "body": body[:600],
                        "kanbanStatus": str(row["status"]),
                        "projectId": str(row["project_id"] or ""),
                        "tenant": str(row["tenant"] or ""),
                        "workspace": workspace,
                        "workspaceKind": str(row["workspace_kind"] or ""),
                        "branch": str(row["branch_name"] or ""),
                        "assignee": str(row["assignee"] or ""),
                        "runProfile": str(row["run_profile"] or ""),
                        "runStatus": str(row["run_status"] or ""),
                        "lastHeartbeatAt": heartbeat,
                    },
                    "ref": {
                        "taskId": task_id,
                        "board": "native",
                        "status": str(row["status"]),
                        "attention": attention["attention"],
                    },
                }
            )
        return threads, []

    def event_cursor(self) -> tuple[int, list[dict[str, Any]]]:
        return self._read(
            lambda connection: int(connection.execute("SELECT COALESCE(MAX(id), 0) FROM task_events").fetchone()[0]),
            0,
        )

    def scan_actors(self) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        def operation(connection: sqlite3.Connection) -> list[dict[str, Any]]:
            rows = connection.execute(
                """
                SELECT
                  t.id AS task_id, t.status AS task_status, t.block_kind,
                  t.last_heartbeat_at AS task_last_heartbeat_at, t.session_id,
                  r.id AS run_id, r.profile, r.status AS run_status,
                  r.last_heartbeat_at AS run_last_heartbeat_at
                FROM tasks t
                LEFT JOIN task_runs r ON r.id = t.current_run_id AND r.task_id = t.id
                WHERE t.status IN ('ready', 'running', 'review', 'blocked')
                   OR (t.status = 'triage' AND t.block_kind IN ('needs_input', 'capability'))
                ORDER BY t.id, r.id
                """
            ).fetchall()
            actors = []
            for row in rows:
                profile = str(row["profile"] or "").lower()
                run_status = str(row["run_status"] or "").lower()
                if row["run_id"] is None or profile not in ACTOR_PROFILES or run_status not in ACTIVE_RUN_STATUSES:
                    continue
                attention = _attention(str(row["task_status"]), str(row["block_kind"] or ""))
                last_at = max(
                    _epoch_milliseconds(row["run_last_heartbeat_at"]),
                    _epoch_milliseconds(row["task_last_heartbeat_at"]),
                )
                freshness = "missing" if not last_at else ("fresh" if max(0, self.now() - last_at) <= FRESH_HEARTBEAT_MS else "stale")
                waiting = attention["requiresMorgan"] or row["task_status"] == "blocked" or run_status == "blocked"
                lifecycle = "waiting" if waiting else ("reviewing" if row["task_status"] == "review" or profile == "reviewer" else "working")
                task_id = str(row["task_id"])
                actors.append(
                    {
                        "id": f"hermes-kanban:actor:{task_id}:{int(row['run_id'])}",
                        "taskId": task_id,
                        "runId": int(row["run_id"]),
                        "profile": profile,
                        "lifecycleState": lifecycle,
                        "heartbeat": {"lastAt": last_at, "freshness": freshness},
                        "requiresMorgan": attention["requiresMorgan"],
                        "managingSession": {"id": str(row["session_id"] or ""), "canOpen": False},
                    }
                )
            return actors

        return self._read(operation, [])

    def actor_snapshot(self) -> dict[str, Any]:
        cursor, warnings = self.event_cursor()
        if warnings:
            return {"actors": [], "cursor": cursor, "through": cursor, "warnings": warnings}
        scan_cursor = cursor
        actors: list[dict[str, Any]] = []
        for _attempt in range(5):
            actors, actor_warnings = self.scan_actors()
            if actor_warnings:
                return {"actors": [], "cursor": cursor, "through": scan_cursor, "warnings": actor_warnings}
            through, cursor_warnings = self.event_cursor()
            if cursor_warnings:
                return {"actors": actors, "cursor": cursor, "through": scan_cursor, "warnings": cursor_warnings}
            if through == scan_cursor:
                return {"actors": actors, "cursor": cursor, "through": through, "warnings": []}
            scan_cursor = through
        return {
            "actors": actors,
            "cursor": cursor,
            "through": scan_cursor,
            "warnings": [{"available": False, "code": "changing", "message": "Lifecycle events changed during the actor snapshot"}],
        }

    def scan_events(self, since: int) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        def operation(connection: sqlite3.Connection) -> dict[str, Any]:
            rows = connection.execute(
                """
                SELECT id, task_id, run_id, kind, payload, created_at
                FROM task_events WHERE id > ? ORDER BY id ASC LIMIT 200
                """,
                (since,),
            ).fetchall()
            cursor = since
            events = []
            for row in rows:
                cursor = int(row["id"])
                if row["kind"] not in ACTOR_EVENT_VOCABULARY:
                    continue
                try:
                    payload = json.loads(row["payload"]) if row["payload"] else None
                except (TypeError, ValueError):
                    payload = None
                events.append(
                    {
                        "id": int(row["id"]),
                        "taskId": str(row["task_id"]),
                        "runId": None if row["run_id"] is None else int(row["run_id"]),
                        "kind": str(row["kind"]),
                        "payload": payload,
                        "createdAt": _epoch_milliseconds(row["created_at"]),
                    }
                )
            return {"cursor": cursor, "events": events}

        return self._read(operation, {"cursor": since, "events": []})
