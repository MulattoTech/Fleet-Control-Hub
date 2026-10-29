# Parity assessment, 2026-10-28

The operational observations below describe the initial assessment. Later controller changes installed BabyTracker's review capability and added a fail-closed bootstrap reconciliation path. Current runtime state must be read from each native controller rather than inferred from these historical observations.

| Capability | MJobs | BabyTracker | Current hub |
| --- | --- | --- | --- |
| Project binding | Native saved manifest spans projects; MJobs scoped restore derives and verifies a MJobs-only subset | `babytracker` verified against application checkout | Fixed adapters; guarded MJobs-only Start preview |
| Automatic dispatch | Sustain and Turbo modes | Bounded Turbo and explicit queue | Never starts dispatch |
| Work eligibility | MJobs productive catalog and review selection | Durable task queue and dependency checks | No scheduling |
| Review lifecycle | MJobs independent documentation review loop with finite decisions | Installed task review receipts; overall requirement acceptance remains unassessed | Displays decision counts where native receipts exist; unsupported decisions stay unknown |
| Quota | Global Codex monitor and emergency latch | Reads shared Codex quota snapshot; AGY separate | No spending decisions |
| Emergency | Machine wide process stop | Project scoped AO termination | Explicit scope label; no emergency proxy |
| Progress | PR/CI, document review state, and lifecycle approval/active/completion counts | Task queue, session activity, acceptance placeholder | Shared work-stage counts; unsupported stages remain unknown |
| Control safety | Sustained/Turbo, emergency latch, drain, and fresh quota | Running/emergency/draining mode and fresh shared quota | Shared safety summary and blocked Start reasons |

BabyTracker likely escaped the observed document review burst because its controller has no equivalent automatic documentation review source, and its queue requires explicit task entries. This is a code-path distinction, not proof of feature parity. Confirm with the fleet audit and dispatch ledgers before drawing a complete historical conclusion.

The hub is a first shared interface, not a completed merge of both controllers. Parity requires one defined work-event contract, a finite review lifecycle, unified control semantics and tests across both projects.

## Acceptance matrix for one controller

| Contract | Required behavior for both projects | Current evidence | Exit check |
| --- | --- | --- | --- |
| Identity and scope | Every mutation names one project and checks live session membership immediately before submission | BabyTracker checks `babytracker` membership; MJobs scoped restore binds the subset to the global snapshot hash | A changed or cross-project manifest is rejected by the native controller before any AO action |
| Start | One intentional click with stable request identity, fresh quota, project binding, and native submission receipts | MJobs current-primary Start and BabyTracker bounded Start; saved-fleet recovery stays advanced | Tests cover duplicate clicks, stale responses, Pause races, pending launch verification without replay, and project isolation |
| Pause and drain | Pause stops new dispatch; drain awaits verified process exit and preserves active work | Both web controls reached native controllers; BabyTracker and MJobs reached zero working sessions | Controller reports a terminal drain outcome only after all scoped sessions are verified stopped |
| Queue and budget | Every dispatch consumes an explicit useful work item and a bounded per-run budget | BabyTracker requires queued tasks; MJobs has productive/review catalogs and Sustained/Turbo | No dispatch occurs from status reads, empty queues, stale quota or exhausted budgets |
| Review | Draft or review output is evidence, then one assessment reaches accepted, revision requested or rejected | MJobs has approval and assessment routes; BabyTracker now has installed per-task review receipts, while overall acceptance remains `NOT_ASSESSED` | Shared receipt schema records source revision, reviewer decision and finite retry count |
| Progress | Both report proposed, approved, active, completed, accepted and blocked counts with timestamps | Hub reduces local MJobs ledgers and BabyTracker queue to a shared count schema; unsupported stages are null | Native controllers expose equivalent stage receipts and timestamps; no task text or private records reach the browser |
| Emergency | Scope and side effects are explicit; recovery cannot silently rearm dispatch | MJobs emergency is machine wide; BabyTracker is project scoped | Tests prove an emergency on one project cannot silently kill or start another |
| Remote control | Owner authentication, request origin and local controller gate are all verified | Protected owner route is deployed and web Pause/Stop reached both native controllers | Authenticated fixture can act only on chosen project; unauthenticated request is denied |

The hub implements a shared work-stage read model and shared Start, pause and drain controls. MJobs native source has atomic scope/revision checks and a MJobs-only derived restore manifest. The hub uses the derived revision for guarded Start. Shared stage counts do not imply equivalent native workflow or assessment semantics.

The MJobs root-fix controller has approval, assessment and completion endpoints. The hub presents a local, capability-gated review queue and one assessment route for both controllers; the native controller remains authoritative for every decision. Ready drafts and review results remain unassessed evidence until a decision is recorded. BabyTracker's installed task review contract, preserved in `packages/babytracker-controller`, checks independent GitHub reviews and caps review attempts. The hub reads its decision receipts when the native controller advertises `reviewAssessment:true`. Remote review assessment is blocked because the hub does not display native evidence remotely. The hub labels MJobs emergency scope as machine-wide and BabyTracker as project-scoped; it does not proxy either emergency action.

At this check, MJobs dispatch was paused and its prior Protected Startup was `failed` from `QUOTA_LOW` at 03:10 UTC, even though a later quota sample was fresh at 45%. Native Startup marks this failure as not needing reconciliation: it occurred before dispatch hold, restore, or any pending action. The current global MJobs restore manifest has 37 targets and includes `babytracker-1` as a primary. The derived MJobs-only preview has 31 targets and one primary (`mjobs-luna-40`); it does not modify the preserved source manifest. Both the source file and its local backup have SHA-256 `512F1102FDED60083393F9D3D097720742013211ED7882C9C9034BAFF807A1D4`. BabyTracker was `draining` with one session still reported working; the hub blocks Start until its drain completes. The hub does not terminate either controller's sessions to clear these states.

BabyTracker's controller transitions from `draining` to `paused` only when its live scoped session feed has no active sessions. The latest read showed five inactive sessions and `babytracker-5` still marked busy, with last activity at 04:53 UTC and no task ID. Its graceful-stop audit records a wind-down submission, not an exit receipt. One earlier `tick_failed` was an `AGENT_EXIT_IN_PROGRESS` response for a different session. The remaining session needs runtime and worktree inspection before any scoped exit or recovery; age alone is not proof that active work has finished.

Scoped MJobs restore now binds the 31-target subset to the unchanged global snapshot hash, verifies project membership and identity on each tick, and fails closed if the binding changes. Native tests cover a changed BabyTracker snapshot entry, noncanonical subset rejection and no BabyTracker commands in a healthy scoped fixture. The production fleet was deliberately not started, so end-to-end live restore behavior remains unverified. Review and emergency semantics still differ between controllers.

## Current Start contract

Normal Hub Start calls MJobs `GET /api/run` / `POST /api/run/start` and BabyTracker `simpleStart`. It does not require typed confirmation, emergency arming, a full recovery roster, or manual refresh. Unknown prompt delivery and unknown native operations remain explicit blockers; a known pending spawn/resume can be reverified without resubmission. Both quota inputs accept zero, and true exhausted allowance still blocks work. MJobs records a quota pause so an allowance reset cannot silently restart this run.

Earlier dated observations above document historical runtime checks. They are not a deployment receipt for the current code.
