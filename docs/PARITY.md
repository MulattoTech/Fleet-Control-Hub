# Parity assessment, 2026-10-28

| Capability | MJobs | BabyTracker | Current hub |
| --- | --- | --- | --- |
| Project binding | MJobs dashboard is `mjobs-luna`, but native saved restore manifest can span projects | `babytracker` verified against application checkout | Fixed adapters; MJobs Start disabled until native atomic project scope exists |
| Automatic dispatch | Sustain and Turbo modes | Bounded Turbo and explicit queue | Never starts dispatch |
| Work eligibility | MJobs productive catalog and review selection | Durable task queue and dependency checks | No scheduling |
| Review lifecycle | MJobs independent documentation review loop | Acceptance remains unassessed without imported evidence | Displays current report |
| Quota | Global Codex monitor and emergency latch | Reads shared Codex quota snapshot; AGY separate | No spending decisions |
| Emergency | Machine wide process stop | Project scoped AO termination | No emergency proxy |
| Progress | PR/CI, document review state, and lifecycle approval/lease/completion counts | Task queue, session activity, acceptance placeholder | Normalized counts and evidence backlog |
| Control safety | Sustained/Turbo, emergency latch, drain, and fresh quota | Running/emergency/draining mode and fresh shared quota | Shared safety summary and blocked Start reasons |

BabyTracker likely escaped the observed document review burst because its controller has no equivalent automatic documentation review source, and its queue requires explicit task entries. This is a code-path distinction, not proof of feature parity. Confirm with the fleet audit and dispatch ledgers before drawing a complete historical conclusion.

The hub is a first shared interface, not a completed merge of both controllers. Parity requires one defined work-event contract, a finite review lifecycle, unified control semantics and tests across both projects.

The MJobs root-fix controller has approval, assessment and completion endpoints. The hub reads its lifecycle counts but does not yet expose those actions. Ready drafts and review results remain unassessed evidence until the controller records acceptance. The BabyTracker acceptance field remains `NOT_ASSESSED` until its own evidence is evaluated.

At this check, MJobs dispatch was paused and its prior Protected Startup was `failed` from `QUOTA_LOW` at 03:10 UTC, even though a later quota sample was fresh at 45%. Native Startup marks this failure as not needing reconciliation: it occurred before dispatch hold, restore, or any pending action. The current MJobs saved restore manifest has 37 targets and includes `babytracker-1` as a primary. The hub blocks MJobs Start because native Startup cannot enforce project scope atomically; a preview check alone would have a race. Native Startup remains the reviewed path for a cross-project restore. BabyTracker was `draining` with one session still reported working; the hub blocks Start until its drain completes. The hub does not terminate either controller's sessions to clear these states.
