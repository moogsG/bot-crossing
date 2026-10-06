import importlib.util
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "hermes-plugin" / "dashboard" / "plugin_api.py"


class FakeRouter:
    def __init__(self):
        self.routes = []

    def get(self, path):
        def decorate(handler):
            self.routes.append(("GET", path, handler))
            return handler
        return decorate


def load_plugin_api():
    fastapi = types.ModuleType("fastapi")
    setattr(fastapi, "APIRouter", FakeRouter)
    hermes_constants = types.ModuleType("hermes_constants")
    setattr(hermes_constants, "get_hermes_home", lambda: Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes")))
    with patch.dict(sys.modules, {"fastapi": fastapi, "hermes_constants": hermes_constants}):
        spec = importlib.util.spec_from_file_location("bot_crossing_plugin_api", MODULE_PATH)
        if spec is None or spec.loader is None:
            raise RuntimeError(f"Could not load {MODULE_PATH}")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    return module


class PluginApiTests(unittest.TestCase):
    def test_health_route_is_read_only_and_namespaced_by_gateway(self):
        module = load_plugin_api()
        self.assertEqual([(method, path) for method, path, _ in module.router.routes], [("GET", "/health")])

    def test_health_uses_effective_named_profile_without_leaking_its_path(self):
        module = load_plugin_api()
        with tempfile.TemporaryDirectory() as root:
            profile_home = Path(root) / "profiles" / "builder"
            profile_home.mkdir(parents=True)
            with patch.dict(os.environ, {"HERMES_HOME": str(profile_home)}, clear=False):
                payload = module.health()

        self.assertEqual(payload, {"status": "healthy", "plugin": "bot-crossing", "profile": "builder"})
        self.assertNotIn(root, repr(payload))

    def test_health_labels_non_profile_custom_homes_without_leaking_paths(self):
        module = load_plugin_api()
        with tempfile.TemporaryDirectory() as custom_home:
            with patch.dict(os.environ, {"HERMES_HOME": custom_home}, clear=False):
                payload = module.health()

        self.assertEqual(payload["profile"], "custom")
        self.assertNotIn(custom_home, repr(payload))


if __name__ == "__main__":
    unittest.main()
