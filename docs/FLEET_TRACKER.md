# Fleet Tracker

## Unified Hub continuation — November 24, 2026 UTC

The Hub root redirects to this shared tracking page. Operator controls remain at
`/controls/` and native project control routes; they do not become the progress
authority. The shared page reads the existing sanitized analytics publication
directory for its inline graphs. Historical samples retain their original time
and unavailable collector status, rather than becoming fresh when served.

Paste a public GitHub repository URL or `owner/name` into **Goal progress
estimate**. Existing MJobs and BabyTracker entries reuse their configured
adapters. Other repositories read a bounded, revision-pinned
`.fleet/progress.json` from the default branch. For example:

```json
{"schema_version":1,"goals":[{"id":"search","title":"Search works","status":"done"},{"id":"recovery","title":"Resume after restart","status":"in_progress"}]}
```

Supported states are `done`, `in_progress`, `not_started`, and `blocked`.
Completion is the unweighted share of goals marked done. If the manifest is
absent, a README task checklist can supply a clearly labeled estimate. Invalid
manifests and missing goals are unavailable, not zero percent or verified PASS.
These are repository-reported estimates, not independent acceptance evidence.
Bookmarks are stored in this browser only (up to20); registration does not clone,
write to GitHub, enable a controller, or start agents. Private repositories are
not supported by this anonymous reader. The protected web ingress uses the same
read-only route without forwarding browser credentials to the reader.

The active continuation uses `codex/fleet-hub-unified-20261123` atop the existing
PR43 head `2752bfa32029649be81489ff096667279d377e2a`, preserving its completed
acceptance, Desktop activity and Grafana work. The paired ingress continuation
uses `codex/fleet-hub-unified-ingress-20261123` atop Access PR48 head
`69153ab3521e2c2d87d7f31022bd7439ec6262c8`. The original review revisions and
installed runtime remain preserved. Private Access CI is blocked; no hosted
rollout, listener retirement or shortcut installation is implied by local tests.

Local continuation verification: the200-test Node suite passed before the final
UI review corrections; all24 affected UI/HTTP tests passed after those changes.
The Python suite passed35 tests and13 subtests. UI synchronization and all three
controller package manifests passed. The ingress continuation passed174 tests
and an isolated `nginx -t`. Browser verification matched live MJobs main at
`9298ae6584f28b5daca40d39e7ff917b4f8de332` (190/366 original,20/59 reference),
rejected a non-GitHub URL, and exercised a clearly synthetic two-goal manifest
through the real reader/API/UI, producing50% and preserving browser selection
after reload. Synthetic results are not repository acceptance.

The native analytics collector also now uses `4320/fleet/api/`, replacing the
retired8787 origin. All four canonical read routes returned200, but native state
reported offline. No AO roster freshness or installed collector repair is
claimed until the reviewed deployment and a fresh successful collection.

The shared tracker is served under `/mission-control/analytics/`. Each selected project declares its repository, branch, and reporting adapters in `projects.json`. The published acceptance reader resolves the public Git branch and validates both matrix files at that commit. A failed refresh preserves the last known counts with a check time and stale state.

MJobs workspace counts and campaign status come from local evidence. The Desktop observer supplies aggregate counts and recent slice timestamps from registered MJobs worktrees. The public-facing projection uses temporary opaque slice labels and omits session identifiers, workspace paths, transcripts, and token data. Existing AO telemetry has its own source and freshness.

## Local verification

Run `npm test`, `npm run verify:ui`, and `npm run verify:packages`. A source checkout can serve the tracker through the existing Fleet Hub. The tracker HTTP routes inherit the Hub's host and remote-owner authentication checks.

The M-TechLabs site and the Grafana Infinity data source can consume static projections. To verify export in an existing disposable directory, run this from the Fleet Control Hub checkout.

```powershell
node tools/export-fleet-tracker.js --output <disposable-directory>
```

The API index and project snapshots appear under `api/projects/`. Grafana reads `desktop-activity.json` from the existing internal analytics mount. Both views calculate freshness against the observation timestamp. The exporter supports foreground monitoring with `--watch` and refreshes approximately every 15 seconds.

**Sync now** sends a same-origin read for the selected project with `refresh=1`. The internal `fleet-control-sync` service checks GitHub, bypasses the normal cache, and preserves the previous observation with explicit stale state if the check fails. The service only serves the tracker project API and reads local observations from the export. Build it with `tools/fleet-control.Dockerfile` and configure `tools/fleet-control.compose.yml` to use the reviewed image and export directory. Its Docker port is internal to the existing Hub network.

The M-TechLabs site must serve the assets and projections through its existing protected origin. Its source also owns the public catalog, legacy URL aliases, and its read-only Grafana proxy. Deploy both repositories through their reviewed release workflows. Verify an authenticated visit, one changing Desktop observation, and a denied anonymous request before handing off a desktop shortcut.

## Windows monitor and shortcut

After the rollout, register `Fleet Control - Tracker Monitor` in the root Task Scheduler folder for the current interactive user in Limited mode. Use `IgnoreNew` for concurrent starts and an unlimited execution time. Configure an on-demand action with `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` (expand the full path) and the following arguments. Use the installed release's absolute script path and the verified loopback site's analytics export directory.

```text
-NoProfile -NonInteractive -WindowStyle Hidden -File "<release>\scripts\Open-Fleet-Tracker.ps1" -Monitor -ExportDirectory "<analytics directory>"
```

The desktop shortcut uses the same PowerShell executable, script and export directory without `-Monitor`. The script checks the task's owner and action before starting it, reuses a running task, and checks activity at the localhost Fleet Control origin before opening the canonical HTTPS view in the default browser. Use `-NoBrowser` for a monitor-only check. This task is separate from the installed native analytics collector.
