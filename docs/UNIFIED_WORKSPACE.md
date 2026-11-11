# Unified Fleet workspace · delivery contract

## Navigation and ownership

| View | Local entry | Owner-protected remote entry | Authority |
| --- | --- | --- | --- |
| Fleet Overview | `127.0.0.1:4320/` | `fleet.m-techlabs.com/` | MJobs + BabyTracker summary and scoped controls |
| MJobs native Fleet | `127.0.0.1:4320/fleet/` | `fleet.m-techlabs.com/fleet/` | Native MJobs controller embedded in Hub 4320; no independent HTTP service |
| BabyTracker native Fleet | `127.0.0.1:4319/` or `127.0.0.1:4320/babytracker/` | `fleet.m-techlabs.com/babytracker/` (owner Access) | BabyTracker controller only |
| Mission evidence API | `127.0.0.1:18726/` (separate optional operator tool) | `m-techlabs.com/mission-control/` reports read-only status | Verified Mission supervisor; Hub acceptance reads canonical matrices itself |
| Fleet Atlas / Grafana | `127.0.0.1:20800/mission-control/analytics/` / `127.0.0.1:18731/mission-control/grafana/` | `m-techlabs.com/mission-control/analytics/` / `.../grafana/` | Sanitized analytics, no fleet commands |

The return-to-overview link stays visible on native Fleet desktop and mobile
views. Native MJobs assets and allowlisted controls now execute inside the
Hub's own Node process on `4320`; neither its fleet controls nor canonical
acceptance reader contacts the deprecated `18729` or `8787` listeners.
The protected `/fleet/` copy returns to its authenticated Hub origin.
BabyTracker likewise uses relative assets and API paths so the identical native
UI works directly on port 4319 and under the protected `/babytracker/` Hub path.
The Hub relays an explicit allowlist of BabyTracker routes only. Native action
tokens and same-origin guards are still required and the native controller
retains all authorization and lifecycle decisions.
The remote BabyTracker action allowlist explicitly excludes local evidence
assessment; adding a native action never exposes it remotely by accident.
Remote activity, Atlas and its turn/token detail drawer use the same generated
Flight Deck tokens. Each has a labelled Fleet Overview return link; local Atlas
cross-links use the actual loopback service ports, not the Grafana origin.

## Refresh and truth

| Data | Browser refresh | Source freshness | Degraded behavior |
| --- | --- | --- | --- |
| Fleet session and quota state | 3 seconds | Native controller timestamp and quota freshness | Unknown/unavailable, not zero |
| MJobs acceptance | 5 seconds | Local canonical matrices, validated on Hub `4320` | No acceptance claim if matrices are missing or invalid; no inferred GitHub sync |
| GitHub main synchronization | Not polled by the local-matrix reader | Local SHA is reported; GitHub SHA remains unverified | Unknown clearly labelled until an independent GitHub check |
| Tracked repository metadata | 15 seconds | Explicit local registry; not live GitHub status | Registry unavailable, no fake adapter |
| Grafana / Fleet Atlas | 30 seconds | Sanitized event collector every 30 seconds | Expire old evidence rather than pretend real-time |

GitHub PR status and CI checks do not by themselves turn acceptance items to
PASS. Only the canonical MJobs acceptance process may update those matrices.
Checkout synchronization compares the checkout that produced the snapshot,
not an unrelated local main ref. Even a matching commit is labelled as a local
working-tree snapshot, not proof of published acceptance. Expanded requirement
areas and workspace disclosures stay open across refreshes.

## Safe expansion

The Add Project form accepts a GitHub `owner/name`, a short display name and up
to 64 absolute local workspaces. It records metadata only; no filesystem scan,
repo clone, credentials, or background agents are run. Paths are never shown to
remote clients. A reviewable adapter is required to turn a tracked project
into a controllable Fleet; controller actions remain disabled until then.
The complete registry has a 256 KB storage cap. Oversized additions are rejected
before replacing the last readable registry; smaller later additions still work.

For a new Mission Control, first define an authenticated, bounded, read-only
progress contract with an explicit source SHA, acceptance authority, observed
timestamp and freshness policy. Never infer progress from commits or agent
activity. Reuse the Flight Deck presentation tokens rather than duplicate
hand-maintained CSS themes. Native controllers retain their separate budgets,
state directories, stop scopes and permissions.

## Single desktop entry

Use **Fleet Control Hub** as the desktop entry. Its hidden wrapper should call
`scripts/Open-Fleet-Workspace.ps1` from the installed, verified Hub release and
show a helpful error if that script exits unsuccessfully. Preserve existing
project shortcuts; an alias does not require a second controller installation.

For source-checkout startup verification without opening a browser:

```powershell
powershell.exe -NoProfile -NonInteractive -File "C:\Tools\Dev\Fleet-Control-Hub\scripts\Open-Fleet-Workspace.ps1" -NoBrowser
```

`-NoBrowser` is startup verification, **not a dry run**: missing dashboards may
be started, but no Fleet Start/control API or agent work is requested. The
launcher preflights the three existing dashboard tasks and their enabled,
`IgnoreNew` settings. It reuses running tasks and healthy detached dashboards
instead of starting duplicates. Fleet dashboard readiness is bounded to
20 seconds. The Hub must advertise its native-controller and local-matrix
source contract; an older Hub cannot pass readiness. The launcher never starts
Mission Control, an AI agent, a controller action, or the retired port 18729.
Existing services and workers are not stopped.

Missing tasks, denied startup, unsafe task settings, and failed health checks
fail visibly. The helper does not change execution policy or repair access
restrictions. Without `-NoBrowser`, it opens `http://127.0.0.1:4320/` only after
Hub, MJobs native controller, and BabyTracker dashboard are ready.
The separate Mission 18726 service remains available for legacy read-only
campaign evidence, but the Hub does not require it.

## Deployment checklist

1. Run `npm run build:ui`, `npm run verify:ui`, `npm run verify:packages`,
   `npm test`, and affected native controller tests.
2. Merge through a reviewed feature PR. Confirm exact main SHA and validate the
   source-package manifest; do not copy private runtime state.
3. Verify all affected controllers are paused before source-only installation;
   preserve installed changes, evidence, secrets, local records and recovery.
4. Restart only the relevant dashboards, not Codex workers or network services.
5. Confirm `4320/`, `4320/fleet/`, `4320/babytracker/`, `4319/`, and Mission 18726
   navigation on desktop and mobile, plus owner-signed-in remote access.
   Verify 18729 has no listener after the verified cutover and its task no longer starts it.
6. Verify Cloudflare Access rejects unauthenticated requests. Observe native
   status without pressing Start, and check that no new agent was dispatched.

This contract does not assert live Grafana availability or installation from
source merely because tests pass. Remote BabyTracker-native parity must be
verified after the source package is safely installed on the owner's machine.
