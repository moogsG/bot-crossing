import importlib.util
import os
import sqlite3
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
DASHBOARD = ROOT / "hermes-plugin" / "dashboard"
MODULE_PATH = DASHBOARD / "plugin_api.py"


class FakeRouter:
    def __init__(self):
        self.routes = []

    def get(self, path):
        def decorate(handler):
            self.routes.append(("GET", path, handler))
            return handler

        return decorate


class FakeJSONResponse:
    def __init__(self, *, status_code, content):
        self.status_code = status_code
        self.content = content


def load_plugin_api():
    for name in [name for name in sys.modules if name == "bot_crossing" or name.startswith("bot_crossing.")]:
        del sys.modules[name]
    fastapi = types.ModuleType("fastapi")
    setattr(fastapi, "APIRouter", FakeRouter)
    responses = types.ModuleType("fastapi.responses")
    setattr(responses, "JSONResponse", FakeJSONResponse)
    hermes_constants = types.ModuleType("hermes_constants")
    setattr(
        hermes_constants,
        "get_hermes_home",
        lambda: Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes")),
    )
    with patch.dict(sys.modules, {"fastapi": fastapi, "fastapi.responses": responses, "hermes_constants": hermes_constants}):
        spec = importlib.util.spec_from_file_location("bot_crossing_plugin_api", MODULE_PATH)
        if spec is None or spec.loader is None:
            raise RuntimeError(f"Could not load {MODULE_PATH}")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    return module


def create_home(root: Path, name: str = "profile") -> tuple[Path, Path]:
    home = root / name
    board_dir = home / "kanban" / "boards" / "native"
    board_dir.mkdir(parents=True)
    board = board_dir / "kanban.db"
    with sqlite3.connect(board) as db:
        db.executescript(
            """
            CREATE TABLE tasks (
              id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT, assignee TEXT, status TEXT NOT NULL,
              created_at INTEGER NOT NULL, started_at INTEGER, workspace_kind TEXT NOT NULL DEFAULT 'scratch',
              workspace_path TEXT, branch_name TEXT, project_id TEXT, tenant TEXT, current_run_id INTEGER,
              block_kind TEXT, last_heartbeat_at INTEGER, session_id TEXT
            );
            CREATE TABLE task_runs (
              id INTEGER PRIMARY KEY, task_id TEXT NOT NULL, profile TEXT, status TEXT NOT NULL,
              started_at INTEGER NOT NULL, last_heartbeat_at INTEGER
            );
            CREATE TABLE task_events (
              id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, run_id INTEGER,
              kind TEXT NOT NULL, payload TEXT, created_at INTEGER NOT NULL
            );
            """
        )
    create_project_registry(home / "projects.db")
    return home, board


def create_project_registry(database: Path):
    database.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(database) as db:
        db.execute(
            "CREATE TABLE projects (id TEXT PRIMARY KEY, slug TEXT, name TEXT, primary_path TEXT, archived INTEGER)"
        )


def insert_task(board: Path, task_id: str, **overrides):
    task = {
        "id": task_id,
        "title": f"Task {task_id}",
        "body": "Body",
        "assignee": "builder",
        "status": "ready",
        "created_at": 100,
        "started_at": None,
        "workspace_kind": "scratch",
        "workspace_path": None,
        "branch_name": None,
        "project_id": None,
        "tenant": None,
        "current_run_id": None,
        "block_kind": None,
        "last_heartbeat_at": None,
        "session_id": None,
        **overrides,
    }
    columns = ", ".join(task)
    values = ", ".join(f":{key}" for key in task)
    with sqlite3.connect(board) as db:
        db.execute(f"INSERT INTO tasks ({columns}) VALUES ({values})", task)


class PluginApiTests(unittest.TestCase):
    def setUp(self):
        self.module = load_plugin_api()

    def test_only_read_only_namespaced_routes_are_registered(self):
        self.assertEqual(
            [(method, path) for method, path, _ in self.module.router.routes],
            [
                ("GET", "/health"),
                ("GET", "/bootstrap"),
                ("GET", "/projects"),
                ("GET", "/threads"),
                ("GET", "/actors"),
                ("GET", "/events"),
            ],
        )

    def test_effective_home_isolates_board_and_project_reads(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first, first_board = create_home(root, "first")
            second, second_board = create_home(root, "second")
            insert_task(first_board, "t_first")
            insert_task(second_board, "t_second")
            with sqlite3.connect(first / "projects.db") as db:
                db.execute("INSERT INTO projects VALUES ('p_first', 'first', 'First', '/first', 0)")
            with sqlite3.connect(second / "projects.db") as db:
                db.execute("INSERT INTO projects VALUES ('p_second', 'second', 'Second', '/second', 0)")

            with patch.dict(os.environ, {"HERMES_HOME": str(first)}, clear=False):
                first_threads = self.module.threads()["threads"]
                first_projects = self.module.projects()["projects"]
            with patch.dict(os.environ, {"HERMES_HOME": str(second)}, clear=False):
                second_threads = self.module.threads()["threads"]
                second_projects = self.module.projects()["projects"]

        self.assertEqual([thread["ref"]["taskId"] for thread in first_threads], ["t_first"])
        self.assertEqual([thread["ref"]["taskId"] for thread in second_threads], ["t_second"])
        self.assertEqual([project["id"] for project in first_projects], ["p_first"])
        self.assertEqual([project["id"] for project in second_projects], ["p_second"])

    def test_nested_profile_uses_shared_board_and_aggregates_root_profile_projects(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            shared_home, board = create_home(root, "hermes")
            active_home = shared_home / "profiles" / "reviewer"
            sibling_home = shared_home / "profiles" / "jynx"
            unrelated_home, unrelated_board = create_home(root, "unrelated")
            create_project_registry(active_home / "projects.db")
            create_project_registry(sibling_home / "projects.db")
            insert_task(board, "t_shared")
            insert_task(unrelated_board, "t_unrelated")
            with sqlite3.connect(shared_home / "projects.db") as db:
                db.execute("INSERT INTO projects VALUES ('p_shared', 'shared', 'Shared', '/shared', 0)")
            with sqlite3.connect(active_home / "projects.db") as db:
                db.execute("INSERT INTO projects VALUES ('p_active', 'active', 'Active', '/active', 0)")
            with sqlite3.connect(sibling_home / "projects.db") as db:
                db.execute("INSERT INTO projects VALUES ('p_other', 'other', 'Other', '/other', 0)")
                db.execute("INSERT INTO projects VALUES ('p_duplicate', 'zzz', 'Duplicate', '/active', 0)")
            with sqlite3.connect(unrelated_home / "projects.db") as db:
                db.execute("INSERT INTO projects VALUES ('p_unrelated', 'unrelated', 'Unrelated', '/unrelated', 0)")
            (shared_home / "profiles" / "escaped").symlink_to(unrelated_home, target_is_directory=True)

            with patch.dict(os.environ, {"HERMES_HOME": str(active_home)}, clear=False):
                health = self.module.health()
                threads = self.module.threads()["threads"]
                projects = self.module.projects()["projects"]

        self.assertEqual(health["status"], "healthy")
        self.assertEqual([thread["ref"]["taskId"] for thread in threads], ["t_shared"])
        self.assertEqual([project["id"] for project in projects], ["p_active", "p_other", "p_shared"])

    def test_wal_active_board_preserves_thread_actor_and_event_contracts(self):
        with tempfile.TemporaryDirectory() as directory:
            home, board = create_home(Path(directory))
            writer = sqlite3.connect(board)
            try:
                writer.execute("PRAGMA journal_mode=WAL")
                insert_task(
                    board,
                    "t_live",
                    status="running",
                    current_run_id=7,
                    last_heartbeat_at=100,
                    session_id="session-7",
                )
                writer.execute(
                    "INSERT INTO task_runs VALUES (7, 't_live', 'builder', 'running', 100, 101)"
                )
                writer.execute(
                    "INSERT INTO task_events (task_id, run_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)",
                    ("t_live", 7, "claimed", '{"source_status":"ready"}', 102),
                )
                writer.execute(
                    "INSERT INTO task_events (task_id, run_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)",
                    ("t_live", 7, "edited", None, 103),
                )
                writer.execute(
                    "INSERT INTO task_events (task_id, run_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)",
                    ("t_live", 7, "heartbeat", "not-json", 104),
                )
                writer.commit()

                with patch.dict(os.environ, {"HERMES_HOME": str(home)}, clear=False):
                    thread = self.module.threads()["threads"][0]
                    actor_payload = self.module.actors()
                    event_payload = self.module.events("0")
            finally:
                writer.close()

        self.assertTrue(thread["running"])
        self.assertFalse(thread["canArchive"])
        self.assertEqual(actor_payload["cursor"], 3)
        self.assertEqual(actor_payload["through"], 3)
        self.assertEqual(actor_payload["actors"][0]["id"], "hermes-kanban:actor:t_live:7")
        self.assertEqual(event_payload["cursor"], 3)
        self.assertEqual([(event["id"], event["kind"]) for event in event_payload["events"]], [(1, "claimed"), (3, "heartbeat")])
        self.assertIsNone(event_payload["events"][1]["payload"])

    def test_unsafe_event_cursors_return_the_standalone_error_contract(self):
        for value in ["1.5", "Infinity", "-1", "9007199254740992", "not-a-number"]:
            response = self.module.events(value)
            self.assertEqual(response.status_code, 400, value)
            self.assertEqual(response.content, {"error": "since must be a non-negative safe integer"})

    def test_terminal_runs_are_suppressed_and_attention_mapping_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            home, board = create_home(Path(directory))
            insert_task(board, "t_done", status="running", current_run_id=8)
            insert_task(board, "t_review", status="review", current_run_id=9)
            insert_task(board, "t_input", status="blocked", block_kind="needs_input")
            with sqlite3.connect(board) as db:
                db.execute("INSERT INTO task_runs VALUES (8, 't_done', 'builder', 'done', 100, 100)")
                db.execute("INSERT INTO task_runs VALUES (9, 't_review', 'reviewer', 'running', 100, 100)")
            with patch.dict(os.environ, {"HERMES_HOME": str(home)}, clear=False):
                actors = self.module.actors()["actors"]
                threads = {thread["ref"]["taskId"]: thread for thread in self.module.threads()["threads"]}

        self.assertEqual([actor["taskId"] for actor in actors], ["t_review"])
        self.assertEqual(actors[0]["lifecycleState"], "reviewing")
        self.assertEqual(threads["t_review"]["ref"]["attention"], "review")
        self.assertTrue(threads["t_input"]["requiresMorgan"])
        self.assertEqual(threads["t_input"]["attentionLabel"], "Requires Morgan")

    def test_absent_incompatible_and_locked_boards_return_bounded_diagnostics(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            absent = root / "absent"
            absent.mkdir()
            with patch.dict(os.environ, {"HERMES_HOME": str(absent)}, clear=False):
                absent_health = self.module.health()
                absent_threads = self.module.threads()

            incompatible = root / "incompatible"
            board_dir = incompatible / "kanban" / "boards" / "native"
            board_dir.mkdir(parents=True)
            sqlite3.connect(board_dir / "kanban.db").close()
            with patch.dict(os.environ, {"HERMES_HOME": str(incompatible)}, clear=False):
                incompatible_threads = self.module.threads()

            locked, locked_board = create_home(root, "locked")
            locker = sqlite3.connect(locked_board, timeout=0)
            try:
                locker.execute("PRAGMA journal_mode=DELETE")
                locker.execute("BEGIN EXCLUSIVE")
                with patch.dict(os.environ, {"HERMES_HOME": str(locked)}, clear=False):
                    locked_threads = self.module.threads()
            finally:
                locker.rollback()
                locker.close()

        self.assertEqual(absent_health["status"], "degraded")
        self.assertEqual(absent_health["board"]["code"], "absent")
        self.assertEqual(absent_threads["threads"], [])
        self.assertEqual(incompatible_threads["warnings"][0]["code"], "incompatible")
        self.assertEqual(locked_threads["warnings"][0]["code"], "locked")
        for payload in [absent_health, absent_threads, incompatible_threads, locked_threads]:
            self.assertLess(len(repr(payload)), 2000)

    def test_health_and_bootstrap_do_not_leak_effective_home_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            profile_home, _ = create_home(root / "profiles", "builder")
            with patch.dict(os.environ, {"HERMES_HOME": str(profile_home)}, clear=False):
                health = self.module.health()
                bootstrap = self.module.bootstrap()

        self.assertEqual(health["profile"], "builder")
        self.assertEqual(bootstrap["source"], "native-kanban")
        self.assertTrue(bootstrap["readOnly"])
        self.assertNotIn(str(root), repr((health, bootstrap)))


if __name__ == "__main__":
    unittest.main()