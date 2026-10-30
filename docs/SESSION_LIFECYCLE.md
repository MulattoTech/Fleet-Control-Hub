# Reusable session lifecycle and project components

The maintained package is `packages/session-lifecycle`. It contains preservation and ownership policy, private archive/checksum operations, durable custody and operation receipts, bounded retries, native adapters, a command-line entry point, a parameterized hidden launcher and synthetic tests. Public source does not contain actual transcripts, backup archives, credentials or runtime logs.

## Ownership before retirement

An exited worker is first preserved, then assigned a durable project custodian. Open PR claims must be transferred using the exact repository/PR identity and verified through native receipts and readback. The receiver gets a bounded handoff pointing to full recorded history, Git evidence and unfinished files. The old session is archived only after the required transfer is proven. Other sessions continue independently; one pending handoff does not hold the dispatcher.

The package does not automatically delete worktrees or branches, force-merge PRs, change quota guards, create replacement armies, or pretend a new conversation is the original provider conversation. Ambiguous native outcomes remain protected against duplicate submission. Routine retry information belongs in status data, not popups; a genuine unresolved condition is not falsely shown as completed.

The previous loose cleaner capped a CLI history request even though that CLI caps each page at 50 turns. The package uses verified native pagination and rechecks totals. It also binds stopped-session identity and generation, current project ownership, file checksums and safety state before changing a native session. The inactivity clock follows actual agent activity, not routine PR metadata refreshes.

## Per-project opt-in foundation

A private project profile explicitly selects `fleetControl`, `missionControl` and `sessionLifecycle`, and binds repository, native project, controller origins and separate state paths. `scripts/attach-project.js` previews a profile registration by default; `--apply` persists configuration only. It never starts an agent or provisions a controller. `src/project-components.js` provides revision-checked preference storage and a sanitized status projection without exporting private file paths or history.

This is a reusable registration/library layer. Existing MJobs and BabyTracker controller contracts are supported; additional controller implementations need an adapter. The Mission Control preference records the requested component; it is not an automatic installation of MJobs' separate Mission Control server into an arbitrary project.

## Current delivery boundary

The updated scheduled-task installer and new lifecycle page write were blocked by the execution safeguards. They were not retried through another mechanism. No new task or public endpoint was installed; the existing retirement schedule was left unchanged. This source package is not yet the machine's unattended cleaner, and no completed live complex-case transfer is claimed. The active Fleet/Mission Control pages and Cloudflare authentication remain separate from this source-only delivery.

The separate Turbo repair changes only its dispatcher-mode transaction and UI state handling. It is independently tested and deployed; lifecycle activation is not required to use Turbo.

## Verification

`npm run verify:packages` validates source hashes. `npm run test:lifecycle` runs synthetic history-pagination, archive-corruption, changed-workspace, ownership-transfer, stale-generation, ambiguous-delivery and per-session recovery cases. `npm test` also verifies per-project component selection and sanitized status. Tests do not change real session ownership or create model turns.

Actual runtime evidence, archives and audit reports remain under private per-project state. The source describes and tests their formats; it does not publish their contents. An installation should use a verified release outside active development worktrees and must replace, not duplicate, the legacy maintenance job. A production transition still needs authorized deployment and live handoff validation.
