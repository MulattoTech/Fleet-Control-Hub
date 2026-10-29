# Fleet Control Hub

**Canonical shared Fleet source:** the hub plus both project-scoped controllers now
live in this repository. BabyTracker and MJobs contain application code, not separate
maintained controller implementations. See [controller packages](docs/CONTROLLER_PACKAGES.md).

```powershell
cd C:\Tools\Dev\Fleet-Control-Hub
npm ci
npm run verify:packages
npm test
npm run test:babytracker
npm run test:mjobs
npm start
```

The BabyTracker package runs with its existing external state directory. The MJobs
package is installed into its existing runtime directory with the source-only,
hash-checked installer; no runtime state is imported into this repository.
`projects.json` records explicit repository, package, port and emergency scope bindings.
The native control semantics still differ; repository consolidation is not a claim
that all lifecycle behavior is interchangeable.

## Existing control contract and historical deployment details

A single local entry point for the **MJobs** and **BabyTracker** fleet controllers. The hub displays both fleets' live session counts, work state and progress evidence with shared work-stage counts. Unsupported stages remain unknown rather than appearing as zero. It offers **Pause dispatch** and **Graceful stop** for each fleet, one-click **Start** through the project controller, and links to existing advanced controls when opened locally.

This is a clean public source repository. It contains no runtime state, logs, tokens, baby records, worktrees or backups. The controllers continue to own their state and authorization. The hub does not start workers on launch or status refresh. Its MJobs progress adapter reads only counts from local review and draft ledgers; it never returns task content to the browser.

## Everyday Start and quota reserve

Use **Start** on the shared Hub or a project dashboard. Both project controls submit directly, coalesce duplicate clicks, and keep polling the actual controller state. A lost response retains its request identity instead of launching a second operation.

MJobs Start checks the live account allowance and resources, prepares monitoring, releases a completed stop after verification, and reuses or resumes the current MJobs primary. If no primary exists, it creates one GPT-5.6 Sol Medium chat orchestrator. An idle primary receives one bounded continuation instruction; an active primary is preserved. Sustained dispatch begins after verification. Historical saved-fleet restoration remains under **Advanced** and is not part of ordinary Start.

The saved **start/new-work reserve accepts 0–99%** in both controllers. At zero reserve, any fresh positive usable balance permits new work. Provider exhaustion, denied usage, unavailable telemetry, and genuinely unverified native submissions still block it. Normal MJobs Start clears an earlier quota trip and disarms legacy automatic termination authority; automatic emergency termination remains a separate opt-in advanced control. Positive saved reserves remain unchanged. After reaching the saved reserve, a normal MJobs run pauses; a later allowance reset does not restart it automatically.

BabyTracker Start uses its project-local run budget and can recognize a completed project stop without a separate rearm. It never changes the shared machine emergency guard, launches MJobs agents, or submits a task just by opening the dashboard. Existing nonzero reserve choices remain saved until intentionally changed.

The shared sources, package hashes, and regression suites cover both projects. Installation remains source-only: deploy a verified package while its controller dispatch is paused, preserve runtime state, and restart only the relevant dashboard processes. Repository tests do not establish that a remote runtime has been updated.

## Run on MulattoTechBox

Requires Node.js 22+ and the installed local controllers:

```powershell
cd C:\path\to\fleet-control-hub
npm test
npm start
```

Open <http://127.0.0.1:4320>. The hub binds only to loopback. MJobs is expected at `127.0.0.1:8787` and BabyTracker at `127.0.0.1:4319`. They may be stopped; the hub then reports them as unavailable. Starting the hub does not start either controller or any fleet.

The MulattoTechBox installation has a dedicated Cloudflare Access route at <https://fleet.m-techlabs.com>. The code keeps remote mode **disabled by default** in other installations; local deployment configuration enables it without adding credentials to Git. Every remote request is checked against the Access application audience, issuer and owner's email. Owner sign-in and live status were verified; see [remote deployment](docs/REMOTE_DEPLOYMENT.md).

## Current control contract

| Feature | MJobs | BabyTracker | Hub |
| --- | --- | --- | --- |
| Live activity and session counts | Native | Native | Unified view |
| Review/acceptance evidence | MJobs review queue | Verified per-task review receipts; overall requirement acceptance remains `NOT_ASSESSED` | Shows reported state |
| Pause new dispatch | Native | Native | Scoped button |
| Graceful stop | Native drain | Native drain | Scoped button |
| Adjustable limits | Sustained and Turbo dispatch profiles | Run concurrency, dispatch count and duration | Project-specific profiles with paused-state, range and stale-value checks |
| Start fleet | Current-primary Start with fresh quota and native verification | Bounded project Start | One click, duplicate-request protection and automatic status polling |
| Advanced saved-fleet restore | Project/revision-bound historical restore | Native recovery | Open advanced controls |
| Emergency stop | Machine wide Codex/AO control | Project scoped AO sessions | Open full controls |
| Runtime state and backups | Local MJobs state | Separate BabyTracker state | None |
| Review assessment | Native review decisions | Installed GitHub-backed task receipts | One local assessment interface, capability gated |

MJobs' emergency stop can affect Codex and AO on the machine. The hub deliberately does not collapse the two emergency operations into one button. Their behavior is different and must be made explicit before parity can be claimed.

The shared view labels each controller's emergency scope and summarizes review decisions without sending evidence text to the browser. Its local review queue shows bounded candidate IDs and outcomes. Recording an assessment requires inspecting the underlying evidence, an exact confirmation, and the native controller's own checks. BabyTracker's review patch is installed on MulattoTechBox; its overall requirement acceptance remains unassessed. Remote review assessment is disabled because the hub does not display the underlying evidence remotely. The reproducible native change is in [the maintained BabyTracker controller](packages/babytracker-controller).

MJobs' native restore manifest can contain sessions from other projects. The controller derives a MJobs-only preview and binds it to the unchanged global snapshot hash. Its bounded mode selects the sole eligible MJobs primary, keeps automatic dispatch off, and checks the exact manifest before native restoration. The reproducible source changes are in [the bounded Start patch](native-patches/mjobs-bounded-start.patch). Two live one-session web Start requests were accepted but failed before agent resume; the second left Protected Startup uncertain. Recheck correctly refused to clear it, and no MJobs agent was dispatched. [The pre-commit proof patch](native-patches/mjobs-precommit-proof.patch) records the prior durable restore fingerprint for future bounded starts and permits read-only reconciliation only after an exact rejection, an unchanged ledger, and fresh absence of all MJobs runtimes. The native source and tests are installed and loaded. That historical recovery record predates the fingerprint. Ordinary Start now separately recognizes this exact pre-commit rejection only with a completed older operation and empty submission ledgers; it preserves the historical record and never replays that restore. A reviewed cross-project restore must use the native controller.

Graceful stop can cause idle sessions to exit and sends a wind-down instruction to active sessions. Its button asks for confirmation. The Limits panel saves each project's native settings only while that project is paused. It requires an exact confirmation, rejects changed values since preview, and reads the controller back after saving. The profiles have different fields because the controllers enforce different work budgets.

## Next integration steps

1. Controller packages are consolidated here; keep deployments bound to their verified manifest and preserve separate runtime state.
2. Define a shared controller interface with project scoped dispatch, budgets, review snapshots and receipts. Require a real work event before dispatch, and make document reviews finite.
3. Replace the advanced controller links with a single control view only after matching lifecycle behavior and cross project safety tests pass.
4. Add a migration tool that imports configuration without copying runtime transcripts or private data into Git.

No existing controller installation is replaced by this release. See [architecture](docs/ARCHITECTURE.md) for the safety boundary and [parity](docs/PARITY.md) for the verified gaps.
