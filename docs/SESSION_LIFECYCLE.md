# Reusable session lifecycle

The maintained package is `packages/session-lifecycle`. It contains preservation and ownership policy, private archive/checksum operations, durable custody and operation receipts, bounded retries, native adapters, a command-line entry point, a parameterized hidden launcher and synthetic tests. Public source does not contain actual transcripts, backup archives, credentials or runtime logs.

## Ownership before retirement

An exited worker is first preserved, then assigned a durable project custodian. Open PR claims must be transferred using the exact repository/PR identity and verified through native receipts and readback. The receiver gets a bounded handoff pointing to full recorded history, Git evidence and unfinished files. The old session is archived only after the required transfer is proven. Other sessions continue independently; one pending handoff does not hold the dispatcher.

The package does not automatically delete worktrees or branches, force-merge PRs, change quota guards, create replacement armies, or pretend a new conversation is the original provider conversation. Ambiguous native outcomes remain protected against duplicate submission. Routine retry information belongs in status data, not popups; a genuine unresolved condition is not falsely shown as completed.

The previous loose cleaner capped a CLI history request even though that CLI caps each page at 50 turns. The package uses verified native pagination and rechecks totals. It also binds stopped-session identity and generation, current project ownership, file checksums and safety state before changing a native session. The inactivity clock follows actual agent activity, not routine PR metadata refreshes.

## Per-project configuration boundary

Lifecycle uses its own private configuration registry supplied explicitly to the package CLI. Each profile binds repository, native project, loopback controller origins and private state paths; the lifecycle registry is intentionally separate from Fleet Hub's existing read-only tracked-project registry and does not replace or extend that registry.

Existing MJobs and BabyTracker controller contracts are supported; additional controller implementations need an adapter. No Fleet Hub UI, project-registration route, or one-click controller installation is added by this source-only salvage.

## Current delivery boundary

No scheduled task, Fleet Hub page, public endpoint, or runtime activation is included in this salvage. The existing workstation retirement schedule remains unchanged. This source package is not the machine's unattended cleaner, and no completed live complex-case transfer is claimed. The active Fleet/Mission Control pages and Cloudflare authentication remain separate from this source-only delivery.

## Verification

`npm run verify:packages` validates source hashes. `npm run test:lifecycle` runs synthetic history-pagination, archive-corruption, changed-workspace, ownership-transfer, stale-generation, ambiguous-delivery and per-session recovery cases. Tests do not change real session ownership or create model turns.

Actual runtime evidence, archives and audit reports remain under private per-project state. The source describes and tests their formats; it does not publish their contents. An installation should use a verified release outside active development worktrees and must replace, not duplicate, the legacy maintenance job. A production transition still needs authorized deployment and live handoff validation.
