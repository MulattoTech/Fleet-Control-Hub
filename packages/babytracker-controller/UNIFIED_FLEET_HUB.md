# Unified Fleet Control — project portal and provider template (2026-10-27)

## What is implemented

The same MJobs dashboard visual system is reused in the BabyTracker controller.
Open `http://127.0.0.1:4319/projects` for a consolidated **read-only**
listing of projects registered in the installed AO daemon:

- BabyTracker — existing independent state/queue/quota limits/emergency latch,
  plus full add-agent / one-turn dispatch control at `/`.
- MJobs - Luna — current native MJobs controller at
  `http://127.0.0.1:8787`. Its running code, state, permissions and agents
  are not changed by this feature.
- Other registered projects — visible with grounded counts, **read-only**
  until an explicit project-owned controller is installed.

No GET request or dashboard loading creates or changes an agent. Portal queries
the AO project/session feed and the existing MJobs dashboard through loopback.
It contains no cross-project POST proxy or shared stop/kill operation.

## BabyTracker Add Agent

Add Agent is an explicitly confirmed `POST /api/action` with
`action:"add-agent"`, a validated provider/model/effort, role and display
name. The controller checks native AO's live repository/path/project binding,
provider authorization, active project membership, RAM, max-agent cap, emergency
state and quota for Codex. It uses AO's native `spawn --project babytracker`
with structured Chat mode for Codex or native Terminal UI mode for AGY in an AO-isolated git worktree; it never launches a shell or
starts a task as part of agent creation. Every new session ID is verified before
reporting success.

A pending or uncertain native submission is saved before spawning and cannot
be blindly repeated after a timeout/restart. `Reconcile agent spawn` verifies
exactly one matching new project-owned session rather than silently resetting
the guard. The existing MJobs sessions are neither adopted nor terminated.

Codex's models are copied *read-only* from the running MJobs' verified
`/api/providers` catalog. If this catalog is unavailable, model creation
fails closed rather than guessing. AGY provider models are discovered locally
from the actual installed `agy models` command. For Google AI Plus, this
interface offers Google's Gemini models, not third-party entitlements.

## Usage safety

- The existing shared Codex account telemetry is checked before Codex spawn
  and every Codex dispatch. Existing local configured 7% threshold is retained.
  If Codex quota becomes insufficient, automatic Codex work stops.
- AGY usage is an **independent** provider allowance. The existing MJobs
  `/api/gemini-usage` read-only feed is displayed as a native observation
  when fresh, but its provider sample age and automatic quota enforcement are
  unverified. An absent number stays unknown.
- Adding AGY requires explicit acknowledgment. One AGY Find Work / Nudge
  requires another explicit confirmation. AGY is excluded from automatic Turbo,
  All Hands, and queued dispatch. A known fresh observed AGY percentage at or
  below the chosen threshold blocks manual AGY actions.
- For paid-overage protection, set **AI Credit Overages = Never** in the user's
  own Antigravity account. This controller cannot read or modify that choice.
- Separate standalone Gemini CLI is **not** installed or enabled; Gemini
  models run through the verified AGY authentication instead.

A manual AGY dispatch can still run longer than the controller's run window or
consume quota during an in-flight turn. Do not claim a precise or unconditional
quota-spend guarantee.

## Design pattern for other projects

1. Register the correct repository/path with AO, then verify it.
2. Create an independent state directory, bounded task ledger, project ID
   binding, and scope-specific stop controls.
3. Reuse the MJobs-derived visual tokens, provider-catalog adapter, and
   guarded native session provisioning, without sharing mutable dispatch state.
4. Add its controller to the unified portal only after its boundaries and
   compatibility are tested.
5. Unifying all project write actions behind the same central URL is a
   separate work item. Never expose unrestricted AO kill/spawn endpoints.

## Evidence to record

Local tests must verify provider IDs, AGY effort-as-model IDs, Codex reasoning
flags, live AO project/repo/path binding, auth, cross-project isolation,
max-agent and emergency limits, uncertain submission/reconciliation,
no automatic AGY work, source health, web origin/token/CSRF guards, and
read-only portal queries. Live AGY sessions should be smoke tested independently
from simulated tests and without synthetic/real infant data.
