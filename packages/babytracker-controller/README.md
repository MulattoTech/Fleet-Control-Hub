# BabyTracker Fleet Control — bounded first slice

This controller reuses the existing MJobs fleet's dispatch ledger, Find Work
classification/instructions, provider catalog and dashboard design. It runs as a
separate loopback service with its own state, queue, budgets and emergency latch.
It **does not load MJobs runtime state or install its machine-wide kill scripts**.

## Current implementation

- Responsive local dashboard at `http://127.0.0.1:4319`.
- Actual BabyTracker session reads from the existing Orchestrator daemon.
- An **All Projects** overview at `/projects`, listing live AO projects with session counts and links to existing scoped controllers. This is a shared landing page, not a cross-project write proxy.
- Explicit project-scoped **Add Agent** for one verified Codex or AGY (Google Gemini) session using the actual AO CLI, with live model/reasoning selection, durable uncertain-delivery reconciliation, no automatic initial task, separate maximum agent count, and no duplicate orchestrator.
- Explicit Start, Pause, Graceful Stop, Emergency Stop, controller Restart,
  Nudge, Find Work, one-pass All Hands and bounded Turbo.
- Durable task proposals, exclusive file assignments and dependencies. **Change model** now uses real native AO conversation settings or a verified same-session provider handoff. Busy turns finish before a cross-provider switch; Codex Chat preferences can change for the next turn without interruption. Historical staged choices remain inert until explicitly applied.
- Separate per-run concurrency, dispatch count, elapsed-time, maximum registered agents, free-memory and
  remaining-account-quota limits. Unknown/stale quota blocks new dispatch.
- A durable dispatch reservation precedes each send. Uncertain delivery is
  preserved across cooldown expiry and restarts and is not automatically retried.
- Emergency latch persists across restart and cannot be downgraded by Pause,
  Graceful Stop or a late graceful-shutdown tick. Only an explicit release after
  fresh verification that project sessions stopped clears it.
- Every native mutation checks live session membership immediately before
  execution. No global process kill, AO-daemon stop, shell command execution,
  host modification or production database access is implemented. Verified Codex and AGY agent provisioning is explicitly user-initiated and never auto-sends an initial task.
- Protected loopback API: Host/origin checks, per-instance action token, JSON
  requests, body limit, CSP and no CORS. The supervisor restarts only its own child.

Runtime dispatch is disabled by default until the live Orchestrator `babytracker`
project has been verified to point to `MulattoTech/BabyTracker` and its correct
source path. This deployment must not assume an identically named project uses
the correct checkout. No model inference is used for dashboard reads.

## Explicitly incomplete

Automatic multi-agent scaling, immediate *mid-turn* model replacement, same-harness AGY Terminal model changes, and generic project onboarding beyond the registered read-only overview,
verified automatic AGY quota enforcement, per-turn token/duration analytics, disk I/O, acceptance
evidence ingestion, automated GitHub task discovery and full Mission Control proxy
integration are not implemented in this slice. The UI marks unsupported metrics
unavailable and acceptance unassessed. No criterion becomes PASS from issue
closure or an agent reporting completion. Queue tasks currently remain submitted
or awaiting reconciliation until an independent acceptance workflow is added.

Emergency Stop uses project-scoped AO session termination. If the AO daemon is
unavailable, it latches dispatch and reports termination **unverified**; it cannot
promise that an unreachable process has stopped. It intentionally has no fallback
that kills all Codex/AO processes on the machine.

Quota is the provider's shared account allowance, not BabyTracker-specific cost.
The controller only reads the existing sanitized quota snapshot. It never arms,
disarms, edits or launches MJobs' global quota/kill monitor. In-flight work and
provider reporting delays mean a percentage threshold is not an exact billing
guarantee. A budget/telemetry gate pauses new assignments and preserves work.

## Run without starting agents

Node.js 22 or newer is sufficient; no npm dependencies are required.

```powershell
$env:BABYTRACKER_FLEET_STATE = 'C:\Tools\BabyTracker-Fleet-State'
$env:BABYTRACKER_SOURCE_PATH = 'C:\Tools\Dev\BabyTracker'
$env:BABYTRACKER_FLEET_PORT = '4319'
node C:\Tools\Dev\BabyTracker\tools\fleet-control\run.js
```

The state directory must be new or already owned by BabyTracker. Never point it
at `C:\Tools\AO-Fleet-Control`, MJobs directories, application persistence volumes
or another controller's state. Source and requirement repositories are fixed:

| Purpose | Repository |
| --- | --- |
| Application source and PRs | `MulattoTech/BabyTracker` |
| Requirements, deployment and fleet source | `MulattoTech/BabyTracker` |
| Orchestrator project ID | `babytracker` |

Use `run.js` for the supervisor-backed Restart button. `node server.js` supports
read-only/dashboard operation too, but reports Restart unavailable. Startup,
refresh, restart and recovery always leave dispatch paused; they never create or
resume a paid worker turn. Port binding plus a state-directory lock prevent a
second controller from using the same state.

For a hidden Windows instance, use `Start-Process -WindowStyle Hidden` with the
explicit Node executable and `run.js`, redirecting output to files outside Git.
No autostart task is installed by this patch; register a project-specific task
only after local review and verification. Do not reuse the MJobs startup task.
The optional [Windows startup helper](WINDOWS_STARTUP.md) prepares independent
configuration and a limited current-user sign-in task without starting it.

## Configuration and dispatch readiness

| Environment variable | Default / behavior |
| --- | --- |
| `BABYTRACKER_FLEET_STATE` | `~/.babytracker-fleet`; all mutable runtime data |
| `BABYTRACKER_FLEET_PORT` | `4319`; binds only `127.0.0.1` |
| `BABYTRACKER_SOURCE_PATH` | `C:\Tools\Dev\BabyTracker` on Windows |
| `BABYTRACKER_AO_URL` | `http://127.0.0.1:3001`; only loopback HTTP origins accepted |
| `BABYTRACKER_AO_PATH` | Existing per-user Windows Orchestrator CLI path |
| `BABYTRACKER_AO_PROJECT_VERIFIED` | Unset: mutations disabled. Set `1` only after independently verifying the project→repository/path binding |
| `BABYTRACKER_CODEX_QUOTA_FILE` | Unset: quota unavailable and new work blocked |
| `BABYTRACKER_CODEX_EXE` | Existing per-user Windows Codex executable path |
| `BABYTRACKER_MODELS_FILE` | Optional local JSON array of verified `{ "id", "name" }` choices; otherwise Codex catalog empty |

Before enabling dispatch, verify the live AO project/repository/path binding,
available sessions, supported provider executable/models and fresh quota feed.
`BABYTRACKER_CODEX_QUOTA_FILE` may point at the existing MJobs sanitized
`quota-guard-status.json` **read-only**; it is not a BabyTracker spending ledger.
It must contain fresh `heartbeatAt`, `lastSuccessfulPoll`, healthy `status` and
finite unexpired `windows[].remainingPercent`. No credentials are read.

When Start is clicked and no active BabyTracker Codex session exists, the
controller verifies AO's live project ID, real checkout path, canonical GitHub
remote and Codex authorization, then asks AO to spawn precisely one Codex
orchestrator using its native isolated worktree. The first native call is
recorded before submission; uncertain outcomes block repeat spawning. Merely
opening the dashboard or booting Windows never creates an agent. Start does
not assign a task; select an available agent's Find Work or explicitly assign
one of the real queued issues to initiate a bounded turn. Starting Codex may
consume provider allowance, so Start requires explicit confirmation.

You can also use **Add Agent** while paused or running to create more BabyTracker workers. Codex models come from MJobs' verified read-only local provider catalog (port 8787); AGY model IDs are discovered from its installed local CLI and restricted to Google's Gemini models. AO supports AGY only in native Terminal UI (`--mode tui`), not structured Chat mode. Codex uses structured Chat. Both require a fresh native AO project/repo/path and provider authorization check before spawning. Only an explicit click can create a session; no prompt is sent automatically. An uncertain native spawn blocks repeat creation until the Reconcile button verifies the exact session.

AGY's Google allowance is distinct from Codex's shared percentage. The native AGY usage feed may be missing or stale; the controller never invents percentages or advertises a verified AGY auto-stop. AGY creation requires a warning confirmation. AGY Find Work/Nudge require separate explicit confirmation for each manual turn; AGY is excluded from Turbo, All Hands and automatic queued dispatch. If fresh AGY quota is observed at/below the configured cutoff, new AGY actions are blocked. Configure Google's **AI Credit Overages = Never** if you want to prevent paid overages; the software cannot inspect this account setting. Standalone Gemini CLI is not required or enabled.

See [UNIFIED_FLEET_HUB.md](UNIFIED_FLEET_HUB.md) for shared portal scope and the next project-template migration steps. See [MODEL_CHANGE_HANDOFF.md](MODEL_CHANGE_HANDOFF.md) for actual model-switch routes, safety limits, and recovery states.

Then start a bounded run explicitly. Default limits are 2 concurrent turns,
8 dispatches, 60 minutes, 20% minimum remaining Codex allowance, 4 GiB free RAM and 12 agents. Existing local accounts may have different user-set limits (including 7%); the persisted values always take precedence.
They are configurable while paused. All Hands runs one bounded pass. Automatic
Turbo sends only existing explicitly assigned queue tasks and pauses when none
remain; it never generates filler tasks or unbounded status prompts.

## Recovery and operation limits

`controller.json`, `dispatch-ledger.json`, `audit.jsonl` and `controller.lock`
belong only in the private state directory. Back up this directory separately
from application data. A corrupt or wrong-project state file blocks startup and
is preserved, not silently replaced. Do not publish runtime files in Git.

Stale controller-lock recovery is serialized with a separate exclusive recovery
lock. An active PID, malformed lock or recovery already in progress blocks a
second controller. If the process crashes during recovery, inspect both lock
owners/processes before removing a stale recovery lock; never remove a live
controller's lock. Supervisor crash recovery is limited to three failures per
minute and preserves paused dispatch.

An uncertain delivery requires manual investigation of the agent conversation,
task and saved reservation before any intervention. This version intentionally
does not offer a blind “retry” or “clear all” button. Original files, branches and
worktrees remain intact. A stopped agent is shown Paused, not falsely Completed.

## Validation

```text
node --test packages/babytracker-controller/test/*.test.js
git diff --check
```

The tests use synthetic sessions/quota and a temporary loopback HTTP
listener. They do not call real provider CLIs, create workers, change production,
read infant data or mutate MJobs. They cover project isolation, quota failure,
run-budget renewal, pending-dispatch concurrency, stop races, uncertain delivery
across restart, file-scope ownership, recovery state and HTTP protections.

Hosted CI, live AO controls, Windows hidden startup and production deployment
must be reported separately from these local tests. This slice must remain
PARTIAL until those checks and the listed unsupported features are complete.

## Upstream attribution

See [NOTICE](NOTICE.md) and [upstream Apache-2.0 license](vendor/mjobs/LICENSE).
The reused code is pinned to MJobs commit
`b73750e37c487a008dfdd2277440a2559d98ecf4`. No runtime state or private data was
copied from the existing fleet.
