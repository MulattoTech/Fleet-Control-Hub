# BabyTracker quota policy

The Start / new-work quota panel saves `minimumRemainingPercent` from 0 through 99. Work requires strictly more remaining quota than that saved reserve. At 0%, any fresh positive balance is eligible; a 0% balance, stale telemetry, or missing telemetry still blocks Codex provisioning and tasks. Saving the policy never starts a paused fleet.

This project setting is independent of MJobs. The shared emergency guard is displayed read-only and is not used as a hidden minimum for this saved reserve. It remains a separate machine-wide control and may independently stop sessions according to its own configuration. Saving 0 does not arm, disarm, or reconfigure that control.

One click Start uses saved limits and existing models. Repeated clicks share an in-flight attempt; Start while running preserves the current run and budget. An intentional Start verifies completed graceful/emergency shutdown and prepares it automatically. Active shutdown, uncertain native provisioning, and unresolved delivery records still require verified recovery. Start never clears those records or retries uncertain native creation. Only BabyTracker sessions are inspected or provisioned; no other project's agents are launched.
