# Unified Fleet workspace · delivery contract

## Navigation and ownership

| View | Local entry | Owner-protected remote entry | Authority |
| --- | --- | --- | --- |
| Fleet Overview | `127.0.0.1:4320/` | `fleet.m-techlabs.com/` | MJobs + BabyTracker summary and scoped controls |
| MJobs native Fleet | `127.0.0.1:18729/fleet/` | `fleet.m-techlabs.com/fleet/` | MJobs controller, with same source on both entries |
| BabyTracker native Fleet | `127.0.0.1:4319/` or `127.0.0.1:4320/babytracker/` | `fleet.m-techlabs.com/babytracker/` (owner Access) | BabyTracker controller only |
| MJobs Mission Control | `127.0.0.1:18726/` | `m-techlabs.com/mission-control/` reports read-only status | MJobs acceptance matrices and launcher |
| Fleet Atlas / Grafana | `127.0.0.1:20800/mission-control/analytics/` / `127.0.0.1:18731/mission-control/grafana/` | `m-techlabs.com/mission-control/analytics/` / `.../grafana/` | Sanitized analytics, no fleet commands |

The return-to-overview link stays visible on native Fleet desktop and mobile
views. On the MJobs native page, direct loopback navigation goes to port 4320;
the Hub's protected `/fleet/` copy returns to the current authenticated origin.
BabyTracker likewise uses relative assets and API paths so the identical native
UI works directly on port 4319 and under the protected `/babytracker/` Hub path.
The Hub relays an explicit allowlist of BabyTracker routes only. Native action
tokens and same-origin guards are still required and the native controller
retains all authorization and lifecycle decisions.

## Refresh and truth

| Data | Browser refresh | Source freshness | Degraded behavior |
| --- | --- | --- | --- |
| Fleet session and quota state | 3 seconds | Native controller timestamp and quota freshness | Unknown/unavailable, not zero |
| MJobs acceptance | 5 seconds | Local Mission Control canonical matrices | No acceptance claim when disconnected |
| GitHub main synchronization | From Mission Control's own cached read | Exact local/GitHub SHA comparison | Mismatch or unknown clearly labelled |
| Tracked repository metadata | 15 seconds | Explicit local registry; not live GitHub status | Registry unavailable, no fake adapter |
| Grafana / Fleet Atlas | 30 seconds | Sanitized event collector every 30 seconds | Expire old evidence rather than pretend real-time |

GitHub PR status and CI checks do not by themselves turn acceptance items to
PASS. Only the canonical MJobs acceptance process may update those matrices.

## Safe expansion

The Add Project form accepts a GitHub `owner/name`, a short display name and up
to 64 absolute local workspaces. It records metadata only; no filesystem scan,
repo clone, credentials, or background agents are run. Paths are never shown to
remote clients. A reviewable adapter is required to turn a tracked project
into a controllable Fleet; controller actions remain disabled until then.

For a new Mission Control, first define an authenticated, bounded, read-only
progress contract with an explicit source SHA, acceptance authority, observed
timestamp and freshness policy. Never infer progress from commits or agent
activity. Reuse the Flight Deck presentation tokens rather than duplicate
hand-maintained CSS themes. Native controllers retain their separate budgets,
state directories, stop scopes and permissions.

## Deployment checklist

1. Run `npm run build:ui`, `npm run verify:ui`, `npm run verify:packages`,
   `npm test`, and affected native controller tests.
2. Merge through a reviewed feature PR. Confirm exact main SHA and validate the
   source-package manifest; do not copy private runtime state.
3. Verify all affected controllers are paused before source-only installation;
   preserve installed changes, evidence, secrets, local records and recovery.
4. Restart only the relevant dashboards, not Codex workers or network services.
5. Confirm `4320/`, `4320/fleet/`, `4320/babytracker/`, `4319/`, Mission Control and analytics
   navigation on desktop and mobile, plus owner-signed-in remote access.
6. Verify Cloudflare Access rejects unauthenticated requests. Observe native
   status without pressing Start, and check that no new agent was dispatched.

This contract does not assert live Grafana availability or installation from
source merely because tests pass. Remote BabyTracker-native parity must be
verified after the source package is safely installed on the owner's machine.
