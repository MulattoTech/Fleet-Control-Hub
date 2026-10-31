# Fleet UI 1.0 / Flight Deck

## User outcome

Open Fleet Control, find the large power action labelled **Start MJobs**, and start the saved mission when the controller permits it. The label does not become a quota message. The adjacent status explains quota holds, unavailable telemetry, starting, running, and uncertain delivery. A 7% remaining reading with a saved 7% reserve stays blocked. Opening or refreshing a page never authorizes a run.

## Canonical source and surfaces

`packages/fleet-ui` contains the shared tokens, responsive styles and pure `FleetPower.present()` read model. `scripts/build-fleet-ui.js` deterministically copies those assets into the shared Hub, native MJobs controls and read-only remote monitor. `npm run verify:ui` detects drift and is included in hosted CI. No framework, externally hosted font, new runtime dependency, or provider credential is needed for the visual layer.

The native page restores the existing ordinary Start section and script on the first content screen, keeps every installed element ID, and separates recovery/configuration into disclosures. The shared Hub uses keyed cards so refreshes preserve focused controls and unfinished settings. Unknown metrics render as unavailable, not invented zeroes. The remote activity page links to the existing protected Fleet Hub; it does not gain a command proxy.

## Design provenance

Taste Skill v2.1.5, from Leonxlnx/taste-skill commit `12af471f627f866411b4bd785b19646d3672784c`, provided the app-screen guidance and seeded `data-terminal` direction. A restrained neutral charcoal surface, consistent spacing, tabular numbers, high-contrast power controls and separate amber hold state replace the older blue dashboard styling. System fonts keep the installed controls offline-capable. Monospace figures and em dashes for unavailable telemetry are intentional functional exceptions to generic prose lint. Labels remain visible; emergency controls are not removed.

## Validation before publication

- Shared Hub: 46 tests passed.
- Native Start UI: 6 tests passed, including no POST at the quota floor and stable Start identity.
- Native run command/controller/adapter: 3 / 11 / 13 tests passed.
- Source-only MJobs package: 193 files verified; generated UI consistency checked.
- Isolated Chromium development previews exercised the actual Hub, native page and remote monitor at 1440, 1024 and 390 pixels. No script exceptions or non-GET requests occurred. Screenshots use fresh test contexts, not the owner's signed-in browser.
- The broader local native suite passed 57 of 58 groups. Its terminal-delivery ownership fixture failed because Windows CIM did not report the synthetic loopback listener. The unchanged baseline fails the same way. No ownership check was weakened, no failure converted to a skip, and no blanket full-suite pass is claimed. Hosted results must be checked separately.
- Taste lint: zero failures; three warnings for monospace figures, a controller label, and unavailable-value dashes. Those uses are intentional.

No paid agent launch or protected-reserve reset is part of visual verification. A successful launch after a future allowance reset is not established by these tests.

## Installation boundaries

Deploy only reviewed UI files into the existing native runtime, with exact-byte backups, while dispatch is paused. Do not overwrite the installed server, quota files, recovery records or conversation histories with a generic package copy. The shared Hub uses an isolated exact-commit source release and its existing authenticated launcher. Preserve all remote authentication settings. The M-TechLabs monitor gets only its three changed static files; retain its live status feed, details script and analytics directory.

## Reuse in future projects

The UI package and normalized presentation example are reusable now. A future project needs an adapter providing its own verified status, quota, capabilities and idempotent Start/Pause operations. The present release does not make arbitrary projects automatically controllable and does not collapse MJobs' machine-level emergency scope into BabyTracker's project-level scope. See `packages/fleet-ui/README.md` for the contract and deliberate limits.
