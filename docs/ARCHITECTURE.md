# Architecture and boundaries

The hub serves one local page on port 4320. Its two fixed adapters read the existing MJobs (`8787`) and BabyTracker (`4319`) APIs. Status responses are reduced to counts and controller health before reaching the browser. Its MJobs progress reader reduces private local review and draft ledgers to counts; it does not expose task content. No transcript, prompt, patient or family data is read. The only proxied mutations are explicit pause and graceful stop for one selected project, using each controller's existing local action gate.

The hub accepts browser actions only from its own loopback origin with a per-process token. Controller URLs are fixed in source and validated as loopback origins. It does not provide an arbitrary URL proxy. A hub restart loses its action token and leaves controller state intact.

The MJobs controller has machine-wide emergency and quota behavior. BabyTracker's controller has a project-scoped emergency latch and reads shared Codex allowance. These cannot be represented as equivalent operations. They also use different state and review models. The adapter layer makes those differences visible until a shared contract is implemented and verified.

Public repository policy: commit source, tests and documentation only. Never commit `.env`, local state, controller snapshots, logs, transcripts, SQLite databases, credentials or records from the BabyTracker app. Check `git diff --cached` before every push.
