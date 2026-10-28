# Canonical controller packages

`packages/babytracker-controller` and `packages/mjobs-controller` are the maintained
controller implementations. The hub's shared adapters remain their common UI/control
interface. Application repositories contain only pointers, not editable duplicates.

BabyTracker state stays outside Git; MJobs keeps its existing installed runtime
folder and generated state. Deployment copies only manifest-listed source files,
never state, credentials, audit records, snapshots, family data or worktrees.

The packages preserve different native emergency scopes and lifecycle safeguards.
Sharing a repository/interface does not imply identical emergency behavior. Do not
remove those distinctions without cross-project isolation tests.

Source provenance and file hashes are in CONTROLLER_MIGRATION_PROVENANCE.json.
Locally installed review, bootstrap, scope and quota fixes are preserved, not replaced
by older main-branch copies. All source must pass package tests before installation.
