# Fleet Tracker

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
