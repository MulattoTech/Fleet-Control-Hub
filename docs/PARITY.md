# Parity assessment, 2026-10-28

| Capability | MJobs | BabyTracker | Current hub |
| --- | --- | --- | --- |
| Project binding | MJobs dashboard is `mjobs-luna`, but native saved restore manifest can span projects | `babytracker` verified against application checkout | Fixed adapters; MJobs Start requires a one-project manifest and native revision binding |
| Automatic dispatch | Sustain and Turbo modes | Bounded Turbo and explicit queue | Never starts dispatch |
| Work eligibility | MJobs productive catalog and review selection | Durable task queue and dependency checks | No scheduling |
| Review lifecycle | MJobs independent documentation review loop | Acceptance remains unassessed without imported evidence | Displays current report |
| Quota | Global Codex monitor and emergency latch | Reads shared Codex quota snapshot; AGY separate | No spending decisions |
| Emergency | Machine wide process stop | Project scoped AO termination | No emergency proxy |
| Progress | PR/CI, document review state, and lifecycle approval/lease/completion counts | Task queue, session activity, acceptance placeholder | Normalized counts and evidence backlog |
| Control safety | Sustained/Turbo, emergency latch, drain, and fresh quota | Running/emergency/draining mode and fresh shared quota | Shared safety summary and blocked Start reasons |

BabyTracker likely escaped the observed document review burst because its controller has no equivalent automatic documentation review source, and its queue requires explicit task entries. This is a code-path distinction, not proof of feature parity. Confirm with the fleet audit and dispatch ledgers before drawing a complete historical conclusion.

The hub is a first shared interface, not a completed merge of both controllers. Parity requires one defined work-event contract, a finite review lifecycle, unified control semantics and tests across both projects.

## Acceptance matrix for one controller

| Contract | Required behavior for both projects | Current evidence | Exit check |
| --- | --- | --- | --- |
| Identity and scope | Every mutation names one project and checks live session membership immediately before submission | BabyTracker checks `babytracker` membership; MJobs saved Startup spans projects | A changed or cross-project manifest is rejected by the native controller before any AO action |
| Start | Preview and commit use the same durable manifest revision, project scope, quota sample and request ID | BabyTracker has bounded Start; MJobs native Startup has a request ID but no atomic project scope | Race test changes manifest after preview and proves no other project starts |
| Pause and drain | Pause stops new dispatch; drain awaits verified process exit and preserves active work | Both have controls; BabyTracker still reports one working session after wind-down | Controller reports a terminal drain outcome only after all scoped sessions are verified stopped |
| Queue and budget | Every dispatch consumes an explicit useful work item and a bounded per-run budget | BabyTracker requires queued tasks; MJobs has productive/review catalogs and Sustained/Turbo | No dispatch occurs from status reads, empty queues, stale quota or exhausted budgets |
| Review | Draft or review output is evidence, then one assessment reaches accepted, revision requested or rejected | MJobs has approval and assessment routes; BabyTracker remains `NOT_ASSESSED` | Shared receipt schema records source revision, reviewer decision and finite retry count |
| Progress | Both report proposed, approved, leased, completed, assessed and blocked counts with timestamps | Hub reduces local MJobs ledgers and BabyTracker queue to counts | Cross-project fixture yields the same schema and never exposes task text or private records |
| Emergency | Scope and side effects are explicit; recovery cannot silently rearm dispatch | MJobs emergency is machine wide; BabyTracker is project scoped | Tests prove an emergency on one project cannot silently kill or start another |
| Remote control | Owner authentication, request origin and local controller gate are all verified | Hub has disabled remote configuration; no route or credential exists | Authenticated fixture can act only on chosen project; unauthenticated request is denied |

The current hub implements the read model and shared pause/drain subset. BabyTracker Start is guarded but its live draining state blocks it. MJobs native source has the atomic scope/revision checks and regression tests; its current cross-project manifest still blocks hub Start. The live controller must load the new source before the hub can use the contract.

The MJobs root-fix controller has approval, assessment and completion endpoints. The hub reads its lifecycle counts but does not yet expose those actions. Ready drafts and review results remain unassessed evidence until the controller records acceptance. The BabyTracker acceptance field remains `NOT_ASSESSED` until its own evidence is evaluated.

At this check, MJobs dispatch was paused and its prior Protected Startup was `failed` from `QUOTA_LOW` at 03:10 UTC, even though a later quota sample was fresh at 45%. Native Startup marks this failure as not needing reconciliation: it occurred before dispatch hold, restore, or any pending action. The current MJobs saved restore manifest has 37 targets and includes `babytracker-1` as a primary. The hub blocks MJobs Start because the roster is not MJobs-only. Native Startup remains the reviewed path for a cross-project restore. BabyTracker was `draining` with one session still reported working; the hub blocks Start until its drain completes. The hub does not terminate either controller's sessions to clear these states.

BabyTracker's controller transitions from `draining` to `paused` only when its live scoped session feed has no active sessions. The latest read showed five inactive sessions and `babytracker-5` still marked busy, with last activity at 04:53 UTC and no task ID. Its graceful-stop audit records a wind-down submission, not an exit receipt. One earlier `tick_failed` was an `AGENT_EXIT_IN_PROGRESS` response for a different session. The remaining session needs runtime and worktree inspection before any scoped exit or recovery; age alone is not proof that active work has finished.
