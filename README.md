# Fleet Control Hub

A single local entry point for the **MJobs** and **BabyTracker** fleet controllers. The hub displays both fleets' live session counts, work state and progress evidence with shared work-stage counts. Unsupported stages remain unknown rather than appearing as zero. It offers **Pause dispatch** and **Graceful stop** for each fleet, guarded **Start fleet** when the native controller proves a safe project scope, and links to existing advanced controls when opened locally.

This is a clean public source repository. It contains no runtime state, logs, tokens, baby records, worktrees or backups. The controllers continue to own their state and authorization. The hub does not start workers on launch or status refresh. Its MJobs progress adapter reads only counts from local review and draft ledgers; it never returns task content to the browser.

## Run on MulattoTechBox

Requires Node.js 22+ and the installed local controllers:

```powershell
cd C:\path\to\fleet-control-hub
npm test
npm start
```

Open <http://127.0.0.1:4320>. The hub binds only to loopback. MJobs is expected at `127.0.0.1:8787` and BabyTracker at `127.0.0.1:4319`. They may be stopped; the hub then reports them as unavailable. Starting the hub does not start either controller or any fleet.

Remote Access support is staged but **disabled by default**. It requires a dedicated Cloudflare Access application and a tunnel connector running on MulattoTechBox, so the origin can remain bound to loopback. Every remote request is verified against the Access application audience, issuer and owner's email. See [remote deployment](docs/REMOTE_DEPLOYMENT.md). No remote route or credential is included in this repository.

## Current control contract

| Feature | MJobs | BabyTracker | Hub |
| --- | --- | --- | --- |
| Live activity and session counts | Native | Native | Unified view |
| Review/acceptance evidence | MJobs review queue | Explicit `NOT_ASSESSED` until evidence | Shows reported state |
| Pause new dispatch | Native | Native | Scoped button |
| Graceful stop | Native drain | Native drain | Scoped button |
| Start fleet | Protected Startup uses a saved restore manifest and now accepts an exact project/revision binding | Bounded Start | Fresh preview and exact confirmation; MJobs requires a MJobs-only roster and atomic revision check |
| Start/restore/dispatch | Native | Native | Open full controls |
| Emergency stop | Machine wide Codex/AO control | Project scoped AO sessions | Open full controls |
| Runtime state and backups | Local MJobs state | Separate BabyTracker state | None |

MJobs' emergency stop can affect Codex and AO on the machine. The hub deliberately does not collapse the two emergency operations into one button. Their behavior is different and must be made explicit before parity can be claimed.

The shared view labels each controller's emergency scope and summarizes review decisions without sending evidence text to the browser. MJobs has explicit accepted, revision requested and rejected review receipts. BabyTracker currently reports unassessed tasks but lacks equivalent review decision receipts, so those decision counts remain unknown.

MJobs' native restore manifest can contain sessions from other projects. The current saved manifest includes BabyTracker. The controller derives a MJobs-only preview with 31 targets from the unchanged 37-target roster. Its scoped restore binds that subset to the global snapshot hash, checks membership and identity on every tick, and rejects a changed snapshot before dispatch. The hub uses the verified subset and exact revision for guarded MJobs Start. No live Start was submitted during this work. A reviewed cross-project restore must use the native controller.

Graceful stop can cause idle sessions to exit and sends a wind-down instruction to active sessions. Its button asks for confirmation.

## Next integration steps

1. Move both controllers into reviewed packages in this repository, preserving their distinct state directories and migration paths.
2. Define a shared controller interface with project scoped dispatch, budgets, review snapshots and receipts. Require a real work event before dispatch, and make document reviews finite.
3. Replace the advanced controller links with a single control view only after matching lifecycle behavior and cross project safety tests pass.
4. Add a migration tool that imports configuration without copying runtime transcripts or private data into Git.

No existing controller installation is replaced by this release. See [architecture](docs/ARCHITECTURE.md) for the safety boundary and [parity](docs/PARITY.md) for the verified gaps.
