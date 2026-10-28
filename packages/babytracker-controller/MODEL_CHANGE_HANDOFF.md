# Native model-change and graceful handoff (2026-10-27)

## What the Apply change button actually does

BabyTracker Fleet Control receives a project-scoped, explicit change request for an
AO session. It validates the selected provider/model/reasoning against the
locally verified model catalog and rechecks the native AO session identity,
project membership and lifecycle state before any mutation.

The current turn is **never cancelled** by model changes. A change requested
while the agent is busy is accepted as a durable queue item. The controller
holds further **new** task dispatch for that agent until the change reaches a
verified terminal state. Existing worktrees, commits, uncommitted edits,
branches, PRs and AO session IDs are preserved. No model handoff merges the
provider-native histories; AO's native handoff note helps the new agent
reconstruct context, which the dashboard should not confuse with an
identical ongoing model context.

## Supported transitions

| Source | Requested | Native AO operation | When effective |
| --- | --- | --- | --- |
| Codex Chat | Another Codex model/effort | PATCH `/api/v1/sessions/{id}/conversation/settings` | Next turn. The current turn keeps its old model. No restart. |
| Codex Chat | AGY Gemini | POST `/interface-transition`, policy `drain`, then POST `/provider-switch` | Only after current work and AO interface transition finish; same session/worktree. |
| Codex Terminal | Another Codex model/effort | Native Terminal → Chat `drain`, then Chat settings PATCH | Next Chat turn after verified transition. |
| Codex Terminal | AGY Gemini | Native POST `/provider-switch` | Once terminal is idle, same session and worktree. |
| AGY Terminal | Codex | Native POST `/provider-switch`, with verified Codex remaining quota | When idle, same session and worktree. |
| AGY Terminal | Different AGY model | **Not supported as an in-place AO API switch.** | Use `/model` in AGY's own terminal or create a separate agent. Do not pretend the dashboard applied it. |

The native provider-switch API rejects a provider already running in the
session. It does not expose an externally verifiable AGY-to-AGY model-only
change. No undocumented keystroke injection, blind process killing, or
global daemon restart is used.

## Durable states

- `queued`: requested, waiting for the current turn to reach an idle boundary.
- `submitting`: durable write fence saved before an actual AO mutation.
- `transitioning`: AO accepted a durable interface transition using a
  non-interrupting drain policy. A later read must confirm completion.
- `applied_next_turn`: native Chat settings PATCH was verified by a fresh read;
  the next turn will use the chosen model/effort if the provider honors them.
- `applied`: live AO session confirms the switched provider/model under the
  same session identity.
- `blocked`: unsupported native change, provider refusal, quota or other
  condition. The prior session remains authoritative.
- `unverified`: native transport outcome was ambiguous; no blind replay.
- `reconcile_required`: interrupted controller while an AO operation was
  submitted. User must explicitly verify.
- `resume_required`: controller restarted with a request queued but not yet
  submitted. No automatic resumption after reboot.
- `cancelled`: a request that had not submitted any native call was cancelled.

A queued change can be cancelled. An unverified change must be reconciled
against native AO state rather than re-sent. After a controller restart, the
dashboard does not autonomously restart paid work, even if a request was
previously queued. Start Fleet and explicitly resume a restart-paused request.

## Quota and security

Codex shared-account telemetry and the persisted 7% safeguard are preserved.
AGY has a **separate** allowance with no verified automatic percentage
cutoff; switching to AGY requires explicit acknowledgement. A fresh observed
AGY quota at or below the threshold blocks a new AGY switch, and AGY is never
included in Turbo/All Hands automatic dispatch.

Only `babytracker` session IDs are accepted. Both controller mutations and AO
native responses are checked against the expected project, session and model
where possible; the original worktree is not deleted by these operations.
The dashboard action API retains loopback Host/Origin checks and its
per-instance session token; a dashboard GET never changes an agent.

Relevant upstream AO interfaces:
- `backend/internal/httpd/controllers/conversations.go` (Chat settings)
- `backend/internal/httpd/controllers/conversation_provider_switch.go`
- `backend/internal/session_manager/provider_switch_tui.go`
- `backend/internal/httpd/controllers/sessions_interface_transition.go`

No generated switch result is evidence that existing GitHub issues or PRs were
completed. Verify actual changes, tests and review separately.
