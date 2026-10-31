"""Run a verified Mission Control code snapshot without editing the active Git checkout."""
from __future__ import annotations

import argparse
import hashlib
import importlib
import json
import sys
from pathlib import Path


def verified_runtime(directory: Path) -> Path:
    code = directory.resolve()
    manifest = json.loads((code / "source-manifest.json").read_text(encoding="utf-8"))
    if manifest.get("schemaVersion") != 1 or not isinstance(manifest.get("files"), dict):
        raise RuntimeError("Mission Control source manifest is invalid")
    files = manifest["files"]
    if not files or len(files) > 500:
        raise RuntimeError("Mission Control source manifest is incomplete")
    for relative, expected in files.items():
        source = (code / relative).resolve()
        if not source.is_relative_to(code) or not source.is_file():
            raise RuntimeError("Mission Control source path is invalid")
        if hashlib.sha256(source.read_bytes()).hexdigest() != expected:
            raise RuntimeError("Mission Control code differs from its installed verification manifest")
    required = "tools/agent_dashboard/server.py"
    if required not in files:
        raise RuntimeError("Mission Control server was not verified")
    return code


def prepend_runtime_path(package, code: Path) -> None:
    """Support both regular packages and PEP 420 namespace package paths."""
    original = list(package.__path__)
    package.__path__ = [str(code / "tools"), *original]



def configure_current_run_proxy(proxy, code: Path) -> None:
    """Register three fixed current-run routes in the verified legacy proxy.

    The existing proxy retains its loopback, origin, action-header, body-size,
    fixed-upstream and no-retry checks. No arbitrary API prefix is admitted.
    """
    relative = "tools/agent_dashboard/fleet_proxy.py"
    expected_path = (code / relative).resolve()
    manifest = json.loads((code / "source-manifest.json").read_text(encoding="utf-8"))
    expected_hash = manifest.get("files", {}).get(relative)
    if Path(getattr(proxy, "__file__", "")).resolve() != expected_path:
        raise RuntimeError("Mission proxy did not load from its verified snapshot")
    if not expected_hash or hashlib.sha256(expected_path.read_bytes()).hexdigest() != expected_hash:
        raise RuntimeError("Mission proxy is not covered by the verified source manifest")
    required = {"ASSETS": {"index.html", "app.js"},
                "READS": {"api/health", "api/startup"},
                "WRITES": {"api/master/pause", "api/startup"}}
    additions = {"ASSETS": {"run-ui.js"}, "READS": {"api/run"},
                 "WRITES": {"api/run/start"}}
    updated = {}
    for name, markers in required.items():
        current = getattr(proxy, name, None)
        if not isinstance(current, set) or not markers.issubset(current):
            raise RuntimeError("Mission proxy route contract has changed")
        updated[name] = current | additions[name]
    for name, routes in updated.items():
        setattr(proxy, name, routes)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True)
    parser.add_argument("--port", type=int, default=18729)
    parser.add_argument("--no-open", action="store_true")
    parser.add_argument("--mission-control", action="store_true")
    args = parser.parse_args()
    if args.port != 18729 or not args.mission_control:
        parser.error("This entry point is restricted to the local Mission Control service")
    repo = Path(args.root).resolve()
    if not (repo / "tools").is_dir():
        raise RuntimeError("Original repository tools package is unavailable")
    code = verified_runtime(Path(__file__).parent / "mission-runtime")
    sys.path.insert(0, str(repo))
    tools = importlib.import_module("tools")
    # Only the reviewed agent_dashboard package is overridden; repository data,
    # Git operations, shared tools, venv and persisted launcher state stay intact.
    prepend_runtime_path(tools, code)
    server = importlib.import_module("tools.agent_dashboard.server")
    proxy = importlib.import_module("tools.agent_dashboard.fleet_proxy")
    configure_current_run_proxy(proxy, code)
    import uvicorn
    uvicorn.run(server.create_app(repo, mission_instance=True), host="127.0.0.1", port=18729, log_level="warning")


if __name__ == "__main__":
    main()
