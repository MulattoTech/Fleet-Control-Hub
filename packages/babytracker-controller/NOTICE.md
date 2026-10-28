# Source attribution and modifications

BabyTracker Fleet Control includes source derived from **MulattoTech/MJobs**,
licensed under Apache License 2.0. The complete license is retained in
`vendor/mjobs/LICENSE`. The upstream copyright NOTICE and third-party notice
are retained verbatim in the same directory.

Pinned source revision:
[b73750e37c487a008dfdd2277440a2559d98ecf4](https://github.com/MulattoTech/MJobs/tree/b73750e37c487a008dfdd2277440a2559d98ecf4/tools/fleet_control).

| Local file | Original source | Changes |
| --- | --- | --- |
| `vendor/mjobs/dispatch-ledger.js` | `tools/fleet_control/dispatch-ledger.js` | Preserve unresolved reservations indefinitely and reject automatic replay after cooldown. |
| `vendor/mjobs/find-work.js` | `tools/fleet_control/find-work.js` | Scope instruction names to BabyTracker; replace job-submission wording with production-data protection. |
| `vendor/mjobs/provider-catalog.js` | `tools/fleet_control/provider-catalog.js` | Unmodified provider-model validation/discovery. |
| `public/mjobs-style.css` | `tools/fleet_control/public/style.css` | Unmodified dashboard theme. |

The project-specific controller, native adapter, API, dashboard bindings,
configuration, supervisor, tests and documentation are new code for BabyTracker.
They do not reuse MJobs' global emergency shutdown, profile modification,
quota monitor launch or restoration of other projects.

This attribution applies to the fleet tooling only. Sprout Track application
source retains its own upstream license in the separate application repository.
