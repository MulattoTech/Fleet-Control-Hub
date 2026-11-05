"""Collector availability contracts using only temporary files and mocked inputs."""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SOURCE = Path(__file__).resolve().parents[2] / "packages/mjobs-controller/collect-analytics.py"
spec = importlib.util.spec_from_file_location("analytics_source_status", SOURCE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class AnalyticsSourceStatusTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="analytics-status-")
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.root, self.publish, self.home = (self.base / name for name in ("root", "public", "home"))
        self.now = module.epoch("2026-11-05T20:00:00Z")
        self.old = module.iso(self.now - 3600)
        self.sample = {"schemaVersion": 1, "generatedAt": self.old,
                       "source": {"available": True}, "summary": {"executing": 7, "outputTokens": 123}}
        self.original = json.dumps(self.sample).encode() + b"\n"
        for target in (self.root / "telemetry", self.publish):
            target.mkdir(parents=True)
            (target / "analytics.json").write_bytes(self.original)

    def status(self):
        private = json.loads((self.root / "telemetry" / "collector-status.json").read_text())
        public = json.loads((self.publish / "collector-status.json").read_text())
        self.assertEqual(private, public)
        self.assertEqual(set(public), {"schemaVersion", "checkedAt", "staleAfterSeconds",
                                      "available", "reasonCode", "message", "lastSuccessAt"})
        self.assertLess(len(json.dumps(public)), 1024)
        return public

    def unchanged_sample(self):
        for target in (self.root / "telemetry", self.publish):
            self.assertEqual((target / "analytics.json").read_bytes(), self.original)

    def test_offline_roster_is_rejected_before_any_database_or_other_endpoint(self):
        roster = {"timestamp": module.iso(self.now), "offline": True,
                  "snapshotAt": self.old, "sessions": [{"id": "PRIVATE_SESSION"}],
                  "offlineReason": "PRIVATE_TOKEN_AND_PATH"}
        cache = self.root / "telemetry" / "analytics.sqlite"
        cache.write_bytes(b"DO NOT OPEN OR RESET")
        with patch.object(module.time, "time", return_value=self.now), \
                patch.object(module, "get", return_value=roster) as read, \
                patch.object(module.sqlite3, "connect", side_effect=AssertionError("database opened")) as connect:
            result = module.collect_with_status(self.root, self.publish, self.home)
        self.assertFalse(result["ok"])
        self.assertEqual(result["reasonCode"], "NATIVE_ROSTER_OFFLINE")
        read.assert_called_once_with("state")
        connect.assert_not_called()
        self.assertEqual(cache.read_bytes(), b"DO NOT OPEN OR RESET")
        self.unchanged_sample()
        status = self.status()
        self.assertFalse(status["available"])
        self.assertEqual(status["checkedAt"], module.iso(self.now))
        self.assertEqual(status["lastSuccessAt"], self.old)
        self.assertNotIn("PRIVATE_", json.dumps(status))

    def test_stale_invalid_and_future_rosters_fail_before_database_access(self):
        for timestamp in (self.old, "not a time", module.iso(self.now + 11)):
            with self.subTest(timestamp=timestamp), \
                    patch.object(module.time, "time", return_value=self.now), \
                    patch.object(module, "get", return_value={"timestamp": timestamp, "offline": False}) as read, \
                    patch.object(module.sqlite3, "connect") as connect:
                with self.assertRaises(module.CollectionUnavailable) as caught:
                    module.collect(self.root, self.publish, self.home)
                self.assertEqual(caught.exception.code, "NATIVE_ROSTER_STALE")
                read.assert_called_once_with("state")
                connect.assert_not_called()
        self.unchanged_sample()

    def test_nonboolean_offline_flags_are_unavailable_not_live(self):
        for offline in ("false", 0, None, [], {}):
            with self.subTest(offline=offline), \
                    patch.object(module.time, "time", return_value=self.now), \
                    patch.object(module, "get", return_value={"timestamp": module.iso(self.now), "offline": offline}) as read, \
                    patch.object(module.sqlite3, "connect") as connect:
                with self.assertRaises(module.CollectionUnavailable) as caught:
                    module.collect(self.root, self.publish, self.home)
                self.assertEqual(caught.exception.code, "NATIVE_ROSTER_OFFLINE")
                read.assert_called_once_with("state")
                connect.assert_not_called()
        self.unchanged_sample()

    def test_changed_identity_has_fixed_reason_and_preserves_last_success(self):
        error = module.CollectionUnavailable("SOURCE_IDENTITY_CHANGED")
        self.assertIsInstance(error, ValueError)
        with patch.object(module.time, "time", return_value=self.now), \
                patch.object(module, "collect", side_effect=error):
            result = module.collect_with_status(self.root, self.publish, self.home)
        self.assertEqual(result["reasonCode"], "SOURCE_IDENTITY_CHANGED")
        self.assertEqual(self.status()["lastSuccessAt"], self.old)
        self.unchanged_sample()

    def test_unknown_errors_never_publish_private_messages(self):
        with patch.object(module.time, "time", return_value=self.now), \
                patch.object(module, "collect", side_effect=OSError("C:\\PRIVATE\\token-secret")):
            result = module.collect_with_status(self.root, self.publish, self.home)
        self.assertEqual(result["reasonCode"], "COLLECTION_UNAVAILABLE")
        serialized = json.dumps({"status": self.status(), "result": result})
        self.assertNotIn("PRIVATE", serialized)
        self.assertNotIn("token-secret", serialized)
        self.unchanged_sample()

    def test_success_clears_unavailable_status_without_redating_old_sample(self):
        with patch.object(module.time, "time", return_value=self.now), \
                patch.object(module, "collect", side_effect=module.CollectionUnavailable("NATIVE_ROSTER_OFFLINE")):
            module.collect_with_status(self.root, self.publish, self.home)
        fresh = module.iso(self.now + 30)

        def successful_collect(*args):
            for target in (self.root / "telemetry", self.publish):
                module.atomic_json(target / "analytics.json", {**self.sample, "generatedAt": fresh})
            return {"at": fresh, "agents": 1, "turns": 0, "events": 0, "bytes": 1, "modelRequests": 0}

        with patch.object(module.time, "time", return_value=self.now + 30), \
                patch.object(module, "collect", side_effect=successful_collect):
            result = module.collect_with_status(self.root, self.publish, self.home)
        self.assertTrue(result["ok"])
        status = self.status()
        self.assertTrue(status["available"])
        self.assertEqual(status["reasonCode"], "OK")
        self.assertEqual(status["lastSuccessAt"], fresh)

    def test_status_publication_failure_is_sanitized_and_not_success(self):
        with patch.object(module, "collect", side_effect=RuntimeError("PRIVATE_ERROR")), \
                patch.object(module, "atomic_json", side_effect=PermissionError("PRIVATE_PATH")):
            result = module.collect_with_status(self.root, self.publish, self.home)
        self.assertFalse(result["ok"])
        self.assertEqual(result["reasonCode"], "STATUS_PUBLICATION_FAILED")
        self.assertNotIn("PRIVATE", json.dumps(result))
        self.unchanged_sample()

    def test_missing_or_invalid_prior_sample_is_unknown_not_zero_or_now(self):
        for raw in (b"{}", b"[]", b"invalid", b'{"generatedAt":"invalid"}', b"x" * (4 * 1024 * 1024 + 1)):
            with self.subTest(length=len(raw)):
                (self.publish / "analytics.json").write_bytes(raw)
                self.assertIsNone(module._last_success_at(self.publish))

    def test_one_shot_failure_exits_nonzero_with_fixed_fields_only(self):
        result = {"at": module.iso(self.now), "ok": False,
                  "reasonCode": "NATIVE_ROSTER_OFFLINE", "modelRequests": 0}
        output = io.StringIO()
        with patch("sys.argv", ["collect-analytics.py", "--root", str(self.root), "--publish", str(self.publish)]), \
                patch.object(module, "collect_with_status", return_value=result), contextlib.redirect_stdout(output):
            self.assertEqual(module.main(), 1)
        self.assertEqual(json.loads(output.getvalue()), result)


if __name__ == "__main__":
    unittest.main()
