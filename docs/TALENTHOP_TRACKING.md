# TalentHop planning evidence in the shared Fleet Hub

MJobs epic: https://github.com/MulattoTech/MJobs/issues/904. Integration slice: https://github.com/MulattoTech/MJobs/issues/905. Catalog/tool PR: https://github.com/MulattoTech/MJobs/pull/907.

The existing Hub now has a read-only capability-roadmap panel. It does not create a second tracker, read native transcripts, or start any fleet. Original P0/P1 acceptance and controller quota/reserve/emergency behavior are unchanged.

## Source and refresh contract

GET /api/parity uses the existing host and Cloudflare Access checks. The only upstream is MulattoTech/MJobs on github.com, through the existing authenticated gh CLI. It resolves current main, fetches docs/talenthop/catalog.json at that exact SHA, then reads bounded issue, open-PR, check-run and claim metadata. A caller cannot supply a repository, file, command, issue list or credential. No account scope is changed.

Requests coalesce, use four concurrent child processes at most, have per-command 10-second and total 25-second deadlines, and cap command output at 2 MB. Catalogs have at most 100 capabilities, 40 referenced issues and 24 relevant claims. Open PR pagination stops after three 100-item pages and fails closed if completeness cannot be established. An incomplete check-run inventory is UNKNOWN, never passing.

Automatic refresh is cached for ten minutes; manual refresh cannot start more often than once per minute. Errors use exponential backoff (one to fifteen minutes); valid Retry-After and exhausted rate-limit reset headers can extend the cooldown. Processes are request-owned and killed on their deadline. The browser polls the read endpoint once per minute, has its own 30-second deadline and restores the control on failure.

A failed refresh preserves the prior snapshot as explicitly STALE and exposes only a fixed error category. A process restart starts unknown and fetches fresh data. No disk cache, GitHub webhook, privileged write endpoint, real-time promise or native worker API is added.

## What the panel establishes

The panel shows feature IDs, qualified discovery, catalog implementation state, dependencies, issue links/state, referenced open PRs, exact-head reported checks, GitHub claim owner commit/run ID, catalog/main revision, coverage, HAR blockers and synchronization time. Input is projected through fixed fields; issue/PR bodies, comments, email identities, raw claims, private evidence and raw errors are not returned.

PR associations are references detected in public PR bodies, not authoritative ownership of a feature. Multiple referenced PRs are a scope-review cue. Reported checks do not prove required protected gates or acceptance. Claim age is displayed only as an age indicator; heartbeat is unknown, and no lock is ever reclaimed.

**This initial slice does not verify merged-PR lineage, production deployment SHA or accepted parity.** Those values remain unknown. The UI states that limitation on each item. A closed issue, old accepted MJobs requirement, passing check or catalog state cannot turn delivery green. Original acceptance matrices remain separate.

Project 1 synchronization is separately blocked by the current GitHub token lacking read:project. The panel does not claim to synchronize the Project board or silently create one. TalentHop session approval and full HAR export are independent audit blockers.

## Verification and rollout

Focused metadata/HTTP/UI tests cover privacy projection, supported status dimensions, bounded pagination, request coalescing, server-directed cooldown, stale recovery, total deadlines, invalid claim ownership, remote Access enforcement, non-existent write routes, text-only rendering, accessible table metadata and absence of fleet dispatch. Existing Hub regression tests and package/UI drift checks cover preserved controls.

An isolated loopback Brave fixture exercised the complete 12-row panel and manual refresh. At a requested 390x844 viewport (375 CSS content pixels after scrollbar), document width and scroll width both measured 375; the 309-pixel table wrapper contained 740-pixel table overflow without widening the page. Native control buttons were unavailable in the fixture. This is synthetic browser/UI evidence, not production or live GitHub synchronization. Temporary viewport override was reset.

Read-only authenticated gh transport parsed the live MJobs main ref successfully. Catalog ingestion from main cannot succeed until MJobs PR #907 is merged. Native Windows used the installed Node 27 alpha; npm issued a version-compatibility warning. The owned install succeeded; full supported Node 24 hosted validation remains required. No global package/runtime changes were made.

Deploy only verified current Hub main under the exclusive deployment claim, preserve installed runtime state and restart only the identified Hub service. Rollback is the prior verified Hub source release; no database/controller migration is introduced. No production deployment is claimed by this document. Review the containing PR's receipt for actual final source, CI, merge and rollout status.
