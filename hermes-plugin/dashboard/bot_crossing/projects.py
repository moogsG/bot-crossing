"""Read-only access to the effective Hermes profile's project registry."""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any


_REQUIRED_COLUMNS = {"id", "slug", "name", "primary_path", "archived"}


def _diagnostic(error: BaseException | None = None, *, absent: bool = False) -> dict[str, Any]:
    if absent:
        return {"available": False, "code": "absent", "message": "Project registry is not available"}
    text = str(error or "").lower()
    if "locked" in text or "busy" in text:
        code, message = "locked", "Project registry is temporarily busy"
    elif isinstance(error, sqlite3.DatabaseError):
        code, message = "incompatible", "Project registry schema is not compatible"
    else:
        code, message = "unavailable", "Project registry could not be read"
    return {"available": False, "code": code, "message": message}


class ProjectReader:
    """Read the project database below one effective HERMES_HOME only."""

    def __init__(self, home: Path):
        self.home = home.expanduser().resolve()
        self.database = self.home / "projects.db"

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
            columns = {row[1] for row in connection.execute("PRAGMA table_info(projects)")}
            if not _REQUIRED_COLUMNS.issubset(columns):
                raise sqlite3.DatabaseError("incompatible projects schema")
        except BaseException:
            connection.close()
            raise
        return connection

    def diagnostic(self) -> dict[str, Any]:
        try:
            connection = self._connect()
            connection.close()
            return {"available": True, "code": "ok", "message": "Project registry is readable"}
        except FileNotFoundError:
            return _diagnostic(absent=True)
        except (OSError, sqlite3.Error) as error:
            return _diagnostic(error)

    def scan(self) -> tuple[list[dict[str, str]], list[dict[str, Any]]]:
        try:
            connection = self._connect()
            try:
                rows = connection.execute(
                    "SELECT id, slug, name, primary_path FROM projects WHERE archived = 0"
                ).fetchall()
            finally:
                connection.close()
        except FileNotFoundError:
            return [], [_diagnostic(absent=True)]
        except (OSError, sqlite3.Error) as error:
            return [], [_diagnostic(error)]

        projects = []
        for row in rows:
            value = str(row["primary_path"] or "")
            project_path = str(Path(value).expanduser().resolve()) if value else ""
            projects.append(
                {
                    "id": str(row["id"]),
                    "slug": str(row["slug"]),
                    "name": str(row["name"]),
                    "path": project_path,
                }
            )
        projects.sort(key=lambda item: (item["slug"], item["id"], item["path"]))
        return projects, []
