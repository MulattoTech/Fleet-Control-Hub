# Session lifecycle package

Canonical, project-scoped source for preservation, ownership transfer and retirement. This replaces the design of the earlier loose workstation cleaner; it is not a bulk-delete utility.

## Transaction

`discovered -> snapshotting -> preserved -> handoff -> retiring -> archived`

A stopped worker must have a known native identity, be inactive for the configured age, and be outside active recovery, replacement and uncertain-delivery ownership. The service then captures every recorded history page, verifies a Git bundle for each owned worktree, captures staged and unstaged binary patches, copies working/untracked files and artifacts, and hashes the archive. It rechecks source stability before accepting the preservation receipt.

Complicated cases receive a durable project custody record. Open PRs are claimed by the single healthy project primary only after checking for conflicting ownership. The native claim receipt must explicitly identify the receiver, the exact repository/PR URL and metadata-only behavior; current native readback is also required. The primary receives one bounded handoff referencing the full private archive. Native message receipt is required before the old worker can be archived. Handoffs obey the separate new-work quota policy as well as the emergency guard.

The service never runs native workspace cleanup, deletes a Git branch, rewrites application history, changes quota settings or spawns replacement agents. A fresh-context handoff is not described as transplanting the prior model's internal conversation state. Reusing the existing primary avoids creating another swarm.

## Failure behavior

Each session has its own durable journal and retry time. An unverified operation is not blindly replayed. A native archive that succeeded just before a connection failure can be recognized on the next run. A newer active session, changed workspace, new PR/task ownership, unavailable receiver or invalid backup stops only that job, not the fleet. Genuine ambiguous native outcomes remain preserved until evidence resolves them; the package does not promise immediate retirement in every case.

There are no routine interactive prompts or notification windows. Pending reasons are available in the status projection rather than forced dialogs. Backup size/file budgets bound the amount of administrative work per run. The default retirement batch is two, with a 24-hour inactivity period based on actual native activity rather than PR-metadata refreshes.

## Private data boundary

Git contains this implementation, tests, a parameterized hidden launcher and configuration templates. Actual histories, native receipts, working files, credentials, archives and audit logs remain in an external private state directory. They must not be committed to this public repository. Nothing is deleted merely because it was copied into an archive.

## Configuration

Use `examples/project.example.json` as the shape of one project profile in a private registry: `{ "version": 1, "projects": [ ... ] }`. Profiles explicitly bind the native project, repository, loopback origins, state paths, enabled state, guard threshold and component preferences. MJobs and BabyTracker controller adapters are available; a new controller contract needs its own adapter.

A diagnostic invocation is:

```
node bin/lifecycle.js --config C:\private\project-components.json --dry-run
```

A run without `--dry-run` can change native PR ownership, deliver a bounded handoff and archive eligible sessions. It requires an explicitly enabled profile and all runtime checks. Administrative file inspection itself does not use model turns; a necessary native handoff can consume a bounded turn on the existing primary.

`windows/Run-Lifecycle.vbs` forwards a Node executable, runner and private registry path without opening a console and preserves the exit status. The source-only controller-package verifier supports this package.

## Delivery status

The source and synthetic regression tests were prepared on October 30, 2026. The workstation's upgraded scheduled-task installer and new page write were blocked by the execution safeguards. The old retirement task was deliberately left unchanged, and this package has NOT been activated for unattended retirement. There is no claim of completed live complex-case transfers in this release. The component-selection library/registration command is a foundation, not a shipped one-checkbox installer for arbitrary repositories.
