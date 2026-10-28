# Visible project concurrency

The parallel-turn limit counts the BabyTracker orchestrator and workers together, across Codex and AGY. It is distinct from maximum registered agents, run-dispatch budget, and provider quota. A limit of 2 means a working orchestrator plus one working worker occupy both slots. Staged Gemini preferences do not change a Codex agent's actual provider.

`capacity.js` is the common read-only source for both the admission check and dashboard. The Parallel Work panel reports actual owners, native provider, role and one of: active turn, recent submission/duplicate-send cooldown, or unresolved delivery. Terminated agents, other projects and expired successful cooldowns do not count. A genuinely uncertain delivery is never automatically cleared just because it is old. Runtime outage shows unavailable, not fabricated free slots.

Idle agents blocked by this limit show **Waiting for slot**, not Available for Dispatch. Find Work, Nudge and All Idle buttons show the relevant eligibility and are disabled when no work can be admitted. API calls still enforce the same cap and return the identities holding slots.

The parallel-turn limit can be saved while running or paused through the protected `concurrency-policy` action. This changes only the local concurrency value (integer 1–32). It does not send an agent prompt, change quota policy, reset the run's dispatch count/deadline, apply staged model preferences, or change paused/running mode. Lowering below current use never kills active work: new sends wait. Raising may enable the existing automatic scheduler, so the browser requests confirmation. Emergency and draining mode reject edits.

The default/current user-selected limit is not silently raised by this update. The user can explicitly choose a larger value in the new panel. AO delegation outside Fleet Control can cause observed use to exceed the dashboard limit; the controller does not kill those turns to force compliance.

Verification: `node --test packages/babytracker-controller/test/*.test.js`. On the target Windows desktop, `node packages/babytracker-controller/smoke-capacity-browser.cjs` launches a separate synthetic server and isolated headless Chrome profile, tests Save at 2 → 4 → 1 with fake busy agents, confirms button eligibility, unchanged run budget/quota and zero native calls, then removes the synthetic resources. It never connects the test controller to real AO sessions.
