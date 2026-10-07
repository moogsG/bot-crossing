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
    """Aggregate project registries within one effective Hermes root."""

    def __init__(self, home: Path):
        self.home = home.expanduser().resolve()
        self.root = self.home.parent.parent if self.home.parent.name == "profiles" else self.home

    def _databases(self) -> list[Path]:
        databases = [self.root / "projects.db"]
        profiles = self.root / "profiles"
        try:
            profile_homes = sorted(
                path for path in profiles.iterdir() if path.is_dir() and not path.is_symlink()
            )
        except OSError:
            profile_homes = []
        databases.extend(path / "projects.db" for path in profile_homes)
        return databases

    @staticmethod
    def _connect(database: Path) -> sqlite3.Connection:
        if not database.is_file():
            raise FileNotFoundError(database)
        connection = sqlite3.connect(
            f"{database.resolve().as_uri()}?mode=ro",
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
        errors: list[BaseException] = []
        for database in self._databases():
            try:
                connection = self._connect(database)
                connection.close()
                return {"available": True, "code": "ok", "message": "Project registry is readable"}
            except FileNotFoundError:
                continue
            except (OSError, sqlite3.Error) as error:
                errors.append(error)
        return _diagnostic(errors[0]) if errors else _diagnostic(absent=True)

    def scan(self) -> tuple[list[dict[str, str]], list[dict[str, Any]]]:
        projects: list[dict[str, str]] = []
        warnings: list[dict[str, Any]] = []
        found = False
        for database in self._databases():
            try:
                connection = self._connect(database)
                found = True
                try:
                    rows = connection.execute(
                        "SELECT id, slug, name, primary_path FROM projects WHERE archived = 0"
                    ).fetchall()
                finally:
                    connection.close()
            except FileNotFoundError:
                continue
            except (OSError, sqlite3.Error) as error:
                warnings.append(_diagnostic(error))
                continue

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
        repositories: dict[str, dict[str, str]] = {}
        for project in projects:
            identity = f"path:{project['path']}" if project["path"] else f"project:{project['id']}"
            repositories.setdefault(identity, project)
        if not found and not warnings:
            warnings.append(_diagnostic(absent=True))
        return list(repositories.values()), warnings
