import unittest

from cloudflared_watchdog import decision, mark_observation, GRACE_SECONDS


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

    def test_outage_after_healthy_period_sets_new_missing_timestamp(self):
        state = {"missing_since": self.now - 500, "attempts": [self.now - 100]}
        mark_observation(state, 1, self.now)
        self.assertIsNone(state["missing_since"])
        mark_observation(state, 0, self.now + 30)
        self.assertEqual(state["missing_since"], self.now + 30)
        mark_observation(state, 0, self.now + 90)
        self.assertEqual(state["missing_since"], self.now + 30)


if __name__ == "__main__":
    unittest.main()
