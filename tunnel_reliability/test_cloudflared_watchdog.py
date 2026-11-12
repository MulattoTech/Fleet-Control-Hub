import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from cloudflared_watchdog import (
    check_once, decision, mark_observation, GRACE_SECONDS, RESTART_WINDOW_SECONDS,
)


class RecoveryPolicyTests(unittest.TestCase):
    def setUp(self):
        self.now = 1_800_000_000.0
        self.target = {
            "taskState": "Ready",
            "processCount": 0,
            "tokenPresent": True,
        }

    def test_restarts_only_after_grace(self):
        self.assertEqual(decision(self.now, self.target, {}, False), "grace")
        self.assertEqual(decision(self.now, self.target, {"missing_since": self.now - GRACE_SECONDS + 1}, False), "grace")
        self.assertEqual(decision(self.now, self.target, {"missing_since": self.now - GRACE_SECONDS}, False), "restart")

    def test_running_connector_never_restarted(self):
        self.target["processCount"] = 1
        self.assertEqual(decision(self.now, self.target, {"missing_since": self.now - 3600}, False), "healthy")

    def test_updates_prevent_recovery(self):
        self.assertEqual(decision(self.now, self.target, {"missing_since": self.now - 3600}, True), "installer_active")

    def test_disabled_or_missing_task_never_started(self):
        self.target["taskState"] = "Disabled"
        self.assertEqual(decision(self.now, self.target, {"missing_since": self.now - 3600}, False), "unmanaged")
        self.target["taskState"] = "Missing"
        self.assertEqual(decision(self.now, self.target, {"missing_since": self.now - 3600}, False), "unmanaged")

    def test_missing_credentials_prevent_recovery(self):
        self.target["tokenPresent"] = False
        self.assertEqual(decision(self.now, self.target, {"missing_since": self.now - 3600}, False), "unmanaged")

    def test_backoff_prevents_repeated_launches(self):
        prior = {"missing_since": self.now - 500, "attempts": [self.now - 100]}
        self.assertEqual(decision(self.now, self.target, prior, False), "backoff")

    def test_three_attempts_per_half_hour(self):
        prior = {"missing_since": self.now - 3600, "attempts": [self.now - 1100, self.now - 700, self.now - 350]}
        self.assertEqual(decision(self.now, self.target, prior, False), "rate_limited")

    def test_old_attempts_do_not_block_recovery(self):
        prior = {"missing_since": self.now - 3600, "attempts": [self.now - 4000]}
        self.assertEqual(decision(self.now, self.target, prior, False), "restart")

    def test_brief_recovery_preserves_restart_cooldown(self):
        state = {"missing_since": self.now - 500, "attempts": [self.now - 10]}
        mark_observation(state, 1, self.now)
        mark_observation(state, 0, self.now + 10)
        self.assertEqual(
            decision(self.now + 10 + GRACE_SECONDS, self.target, state, False),
            "backoff",
        )

    def test_brief_recovery_preserves_rolling_restart_limit(self):
        state = {
            "missing_since": self.now - 1500,
            "attempts": [self.now - 1000, self.now - 600, self.now - 300],
        }
        mark_observation(state, 1, self.now)
        mark_observation(state, 0, self.now + 10)
        self.assertEqual(
            decision(self.now + 10 + GRACE_SECONDS, self.target, state, False),
            "rate_limited",
        )

    def test_outage_after_healthy_period_sets_new_missing_timestamp(self):
        state = {"missing_since": self.now - 500, "attempts": [self.now - 100]}
        mark_observation(state, 1, self.now)
        self.assertIsNone(state["missing_since"])
        mark_observation(state, 0, self.now + 30)
        self.assertEqual(state["missing_since"], self.now + 30)
        mark_observation(state, 0, self.now + 90)
        self.assertEqual(state["missing_since"], self.now + 30)


class RecoveryHistoryPersistenceTests(unittest.TestCase):
    def test_healthy_observations_persist_recent_attempts_until_window_expires(self):
        now = 1_800_000_000.0
        recent_attempt = now - 200
        name = "Fleet Control Tunnel"
        current = {"installerActive": False, "targets": [{
            "name": name, "taskState": "Running", "processCount": 1,
            "tokenPresent": True,
        }]}
        with tempfile.TemporaryDirectory() as directory:
            state_dir = Path(directory)
            state_path = state_dir / "state.json"
            state_path.write_text(json.dumps({"targets": {name: {
                "missing_since": now - 500,
                "attempts": [now - RESTART_WINDOW_SECONDS, recent_attempt],
            }}}), encoding="utf-8")
            with patch("cloudflared_watchdog.snapshot", return_value=current), \
                    patch("cloudflared_watchdog.origin_reachable", return_value=True), \
                    patch("cloudflared_watchdog.restart_task") as restart:
                with patch("cloudflared_watchdog.time.time", return_value=now):
                    result = check_once(state_dir)
                self.assertEqual(result["targets"][0]["status"], "healthy")
                tracked = json.loads(state_path.read_text(encoding="utf-8"))["targets"][name]
                self.assertIsNone(tracked["missing_since"])
                self.assertEqual(tracked["attempts"], [recent_attempt])

                # The same history ages out at the exact rolling-window boundary.
                with patch("cloudflared_watchdog.time.time",
                           return_value=recent_attempt + RESTART_WINDOW_SECONDS):
                    check_once(state_dir)
                tracked = json.loads(state_path.read_text(encoding="utf-8"))["targets"][name]
                self.assertEqual(tracked["attempts"], [])
                restart.assert_not_called()


if __name__ == "__main__":
    unittest.main()
