"""The installed dashboard uses verified code without changing active main."""
import hashlib
import importlib.util
import json
from pathlib import Path

import pytest

SOURCE = Path(__file__).resolve().parents[2] / "packages/mjobs-controller/Run-Mission-Control.py"
spec = importlib.util.spec_from_file_location("fleet_mission_entry", SOURCE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def fixture_code(root):
    source = root / "tools/agent_dashboard/server.py"
    source.parent.mkdir(parents=True)
    source.write_text("# fixture, no process launched\n", encoding="utf-8")
    data = {"schemaVersion": 1, "files": {"tools/agent_dashboard/server.py": hashlib.sha256(source.read_bytes()).hexdigest()}}
    (root / "source-manifest.json").write_text(json.dumps(data), encoding="utf-8")
    return source, data


def test_verified_dashboard_snapshot(tmp_path):
    fixture_code(tmp_path)
    assert module.verified_runtime(tmp_path) == tmp_path.resolve()


def test_changed_code_is_not_silently_launched(tmp_path):
    source, _ = fixture_code(tmp_path)
    source.write_text("# changed\n", encoding="utf-8")
    with pytest.raises(RuntimeError, match="differs"):
        module.verified_runtime(tmp_path)


def test_manifest_cannot_read_outside_runtime(tmp_path):
    _, data = fixture_code(tmp_path)
    data["files"]["../outside.py"] = "0" * 64
    (tmp_path / "source-manifest.json").write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(RuntimeError, match="path is invalid"):
        module.verified_runtime(tmp_path)


def test_missing_server_is_not_a_complete_snapshot(tmp_path):
    _, data = fixture_code(tmp_path)
    data["files"] = {"source-manifest.json": "0" * 64}
    (tmp_path / "source-manifest.json").write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(RuntimeError):
        module.verified_runtime(tmp_path)


def test_namespace_package_path_is_supported_without_insert(tmp_path):
    from types import SimpleNamespace

    class NamespacePath:
        def __iter__(self):
            return iter(["original/tools"])

    package = SimpleNamespace(__path__=NamespacePath())
    module.prepend_runtime_path(package, tmp_path)
    assert package.__path__ == [str(tmp_path / "tools"), "original/tools"]


def test_original_namespace_repository_and_snapshot_import_in_fresh_process(tmp_path):
    import subprocess
    import sys

    repo = tmp_path / "repo"
    (repo / "tools").mkdir(parents=True)
    code = tmp_path / "verified"
    source, _ = fixture_code(code)
    source.write_text("VALUE = 'reviewed-snapshot'\n", encoding="utf-8")
    script = (
        "import importlib,runpy,sys;from pathlib import Path;"
        "m=runpy.run_path(sys.argv[1],run_name='fixture');"
        "sys.path.insert(0,sys.argv[2]);p=importlib.import_module('tools');"
        "m['prepend_runtime_path'](p,Path(sys.argv[3]));"
        "s=importlib.import_module('tools.agent_dashboard.server');"
        "assert s.VALUE=='reviewed-snapshot';print('PASS namespace overlay')"
    )
    result = subprocess.run([sys.executable, "-I", "-c", script, str(SOURCE), str(repo), str(code)],
                            capture_output=True, text=True, timeout=10, check=True)
    assert "PASS namespace overlay" in result.stdout


def proxy_fixture(root):
    from types import SimpleNamespace
    fixture_code(root)
    source = root / "tools/agent_dashboard/fleet_proxy.py"
    source.write_text("# fixed-target proxy fixture\n", encoding="utf-8")
    manifest = json.loads((root / "source-manifest.json").read_text())
    manifest["files"]["tools/agent_dashboard/fleet_proxy.py"] = hashlib.sha256(source.read_bytes()).hexdigest()
    (root / "source-manifest.json").write_text(json.dumps(manifest))
    return SimpleNamespace(__file__=str(source), ASSETS={"index.html", "app.js"},
                           READS={"api/health", "api/startup"},
                           WRITES={"api/master/pause", "api/startup"})


def test_current_run_routes_are_exact_and_idempotent(tmp_path):
    proxy = proxy_fixture(tmp_path)
    before = {name: set(getattr(proxy, name)) for name in ("ASSETS", "READS", "WRITES")}
    for _ in range(2):
        module.configure_current_run_proxy(proxy, tmp_path)
    assert proxy.ASSETS == before["ASSETS"] | {"run-ui.js"}
    assert proxy.READS == before["READS"] | {"api/run"}
    assert proxy.WRITES == before["WRITES"] | {"api/run/start"}
    assert "api/run/start" not in proxy.READS
    assert "api/run" not in proxy.WRITES


def test_current_run_routes_require_verified_proxy(tmp_path):
    proxy = proxy_fixture(tmp_path)
    Path(proxy.__file__).write_text("# changed\n")
    with pytest.raises(RuntimeError, match="manifest"):
        module.configure_current_run_proxy(proxy, tmp_path)
    assert "run-ui.js" not in proxy.ASSETS


def test_current_run_routes_reject_foreign_module(tmp_path):
    proxy = proxy_fixture(tmp_path)
    proxy.__file__ = str(tmp_path / "outside.py")
    with pytest.raises(RuntimeError, match="snapshot"):
        module.configure_current_run_proxy(proxy, tmp_path)
    assert "run-ui.js" not in proxy.ASSETS


def test_changed_route_contract_cannot_partially_register(tmp_path):
    proxy = proxy_fixture(tmp_path)
    proxy.WRITES = ["api/master/pause", "api/startup"]
    with pytest.raises(RuntimeError, match="contract"):
        module.configure_current_run_proxy(proxy, tmp_path)
    assert "run-ui.js" not in proxy.ASSETS
    assert "api/run" not in proxy.READS
