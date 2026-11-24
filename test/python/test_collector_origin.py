"""The native collector reads the embedded Fleet API only."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import urllib.error
from unittest.mock import MagicMock, patch


SOURCE = Path(__file__).resolve().parents[2] / "packages/mjobs-controller/collect-analytics.py"
spec = importlib.util.spec_from_file_location("collector_origin", SOURCE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CollectorOriginTests(unittest.TestCase):
    def test_reads_all_native_routes_from_embedded_loopback_api(self):
        response = MagicMock()
        response.__enter__.return_value = response
        response.read.return_value = b"{}"
        opener = MagicMock()
        opener.open.return_value = response

        with patch.object(module.urllib.request, "build_opener", return_value=opener) as build:
            for route in ("state", "sustain", "master", "quota"):
                self.assertEqual(module.get(route), {})
                call = opener.open.call_args
                request_url = call.args[0]
                self.assertEqual(request_url, f"http://127.0.0.1:4320/fleet/api/{route}")
                self.assertEqual(call.kwargs["timeout"], 8)

        self.assertEqual(build.call_count, 4)
        self.assertTrue(all(call.args == (module.NoRedirect,) for call in build.call_args_list))
        self.assertEqual(opener.open.call_count, 4)

    def test_rejects_routes_outside_native_allowlist(self):
        with patch.object(module.urllib.request, "build_opener") as build:
            with self.assertRaises(AssertionError):
                module.get("private")
        build.assert_not_called()

    def test_api_failure_publishes_fixed_unavailable_status_and_keeps_last_success(self):
        with tempfile.TemporaryDirectory(prefix="collector-origin-") as temporary:
            base = Path(temporary)
            root, publish = base / "root", base / "publish"
            (root / "telemetry").mkdir(parents=True)
            publish.mkdir()
            last_success = "2026-11-23T17:00:00Z"
            for directory in (root / "telemetry", publish):
                (directory / "analytics.json").write_text(
                    json.dumps({"generatedAt": last_success}), encoding="utf-8"
                )

            with patch.object(module.time, "time", return_value=1795455000), \
                    patch.object(module, "get", side_effect=urllib.error.URLError("private endpoint details")):
                result = module.collect_with_status(root, publish, base / "home")

            status = json.loads((publish / "collector-status.json").read_text(encoding="utf-8"))
            self.assertFalse(result["ok"])
            self.assertEqual(result["reasonCode"], "COLLECTION_UNAVAILABLE")
            self.assertEqual(status["reasonCode"], "COLLECTION_UNAVAILABLE")
            self.assertEqual(status["lastSuccessAt"], last_success)
            self.assertNotIn("private endpoint details", json.dumps({"result": result, "status": status}))


if __name__ == "__main__":
    unittest.main()
