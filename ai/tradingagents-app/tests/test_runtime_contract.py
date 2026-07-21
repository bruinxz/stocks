import ast
import unittest
from pathlib import Path


APP_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = Path(__file__).resolve().parents[3]


class VendoredRuntimeContractTest(unittest.TestCase):
    def test_managed_api_exposes_every_backend_route_once(self):
        api_source = (APP_ROOT / "api.py").read_text(encoding="utf-8")
        tree = ast.parse(api_source)
        routes = []
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for decorator in node.decorator_list:
                if not isinstance(decorator, ast.Call) or not decorator.args:
                    continue
                func = decorator.func
                if (
                    isinstance(func, ast.Attribute)
                    and isinstance(func.value, ast.Name)
                    and func.value.id == "app"
                    and func.attr in {"get", "post"}
                    and isinstance(decorator.args[0], ast.Constant)
                ):
                    routes.append((func.attr, decorator.args[0].value))

        required = {
            ("post", "/api/analyze"),
            ("get", "/api/analyze/stream"),
            ("get", "/api/tasks/{task_id}"),
            ("post", "/api/market-brief"),
            ("post", "/api/attribution-summary"),
            ("post", "/api/diary-summary"),
            ("post", "/api/trading-journal"),
            ("post", "/api/nlp-summary"),
            ("post", "/api/nlp-technical-analysis"),
            ("get", "/health"),
        }
        self.assertEqual(required, set(routes))
        self.assertEqual(len(routes), len(set(routes)))

    def test_runtime_has_no_legacy_direct_entrypoints(self):
        for name in ("test.py", "test_local.py", "test_concurrent.py", "fetch_db_data.py"):
            self.assertFalse((APP_ROOT / name).exists(), name)

        runtime_files = [
            APP_ROOT / "api.py",
            APP_ROOT / "main.py",
            APP_ROOT / "tradingagents" / "utils" / "env_config.py",
        ]
        for path in runtime_files:
            tree = ast.parse(path.read_text(encoding="utf-8"))
            opened_names = {
                node.args[0].value
                for node in ast.walk(tree)
                if isinstance(node, ast.Call)
                and isinstance(node.func, ast.Name)
                and node.func.id == "open"
                and node.args
                and isinstance(node.args[0], ast.Constant)
                and isinstance(node.args[0].value, str)
            }
            self.assertNotIn("config.json", opened_names, str(path))

    def test_all_mutable_paths_use_shared_runtime_configuration(self):
        graph = (APP_ROOT / "tradingagents" / "graph" / "trading_graph.py").read_text(
            encoding="utf-8"
        )
        local_cache = (
            APP_ROOT / "tradingagents" / "dataflows" / "local_db_handler.py"
        ).read_text(encoding="utf-8")
        unit = (
            REPO_ROOT / "scripts" / "deployment" / "samples" / "stocks-tradingagents.service"
        ).read_text(encoding="utf-8")

        self.assertIn('os.makedirs(self.config["data_cache_dir"]', graph)
        self.assertNotIn('self.config["project_dir"], "dataflows/data_cache"', graph)
        self.assertIn("TRADINGAGENTS_DATA_CACHE_DIR", local_cache)
        self.assertIn("ProtectSystem=strict", unit)
        self.assertIn("ReadWritePaths=/opt/stocks/shared/tradingagents", unit)

    def test_backend_cannot_redirect_to_a_remote_runtime(self):
        external_services = (
            REPO_ROOT / "backend" / "src" / "config" / "externalServices.ts"
        ).read_text(encoding="utf-8")
        self.assertIn("http://127.0.0.1:8000", external_services)
        self.assertNotIn("process.env.TRADING_AGENTS_URL", external_services)

    def test_health_requires_secret_internal_api_and_database_readiness(self):
        api_source = (APP_ROOT / "api.py").read_text(encoding="utf-8")
        self.assertIn("credential_ready and internal_api_ready and database_ready", api_source)
        self.assertIn('"runtime": "vendored"', api_source)


if __name__ == "__main__":
    unittest.main()
