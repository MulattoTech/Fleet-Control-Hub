# Parity assessment, 2026-10-28

| Capability | MJobs | BabyTracker | Current hub |
| --- | --- | --- | --- |
| Project binding | `mjobs-luna` | `babytracker` verified against application checkout | Read only adapters |
| Automatic dispatch | Sustain and Turbo modes | Bounded Turbo and explicit queue | Never starts dispatch |
| Work eligibility | MJobs productive catalog and review selection | Durable task queue and dependency checks | No scheduling |
| Review lifecycle | MJobs independent documentation review loop | Acceptance remains unassessed without imported evidence | Displays current report |
| Quota | Global Codex monitor and emergency latch | Reads shared Codex quota snapshot; AGY separate | No spending decisions |
| Emergency | Machine wide process stop | Project scoped AO termination | No emergency proxy |
| Progress | PR/CI and document review state | Task queue, session activity, acceptance placeholder | Normalized counts and evidence backlog |

BabyTracker likely escaped the observed document review burst because its controller has no equivalent automatic documentation review source, and its queue requires explicit task entries. This is a code-path distinction, not proof of feature parity. Confirm with the fleet audit and dispatch ledgers before drawing a complete historical conclusion.

The hub is a first shared interface, not a completed merge of both controllers. Parity requires one defined work-event contract, a finite review lifecycle, unified control semantics and tests across both projects.

The MJobs root-fix work has staged new lifecycle approval, assessment and completion endpoints in its controller. Integrate those endpoints into the shared progress contract after their owner finishes verification and the controller is safely restarted. Until then, the hub treats ready drafts and reviews as unassessed evidence, not completed work.
