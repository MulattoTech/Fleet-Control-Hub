# Fleet UI · Flight Deck 1.0

Reusable **presentation** for project-scoped AI orchestration. This package does not launch models, discover credentials, grant permissions or bypass quotas. The first action is permanently named `Start <project>`. Runtime status appears beside it, never instead of its name.

## Use in another project

Copy `tokens.css`, a relevant layout stylesheet and `power-state.js`. The JavaScript has no dependencies and exports `FleetPower.present()` in a browser and CommonJS `present()` in Node. Pass your controller's own observed state:

```js
const presentation = FleetPower.present({
  name: 'Research Lab', online: true, known: true,
  phase: 'paused', active: false, running: false,
  quota: { fresh: true, remainingPercent: 80, minimumRemainingPercent: 7, blocked: false },
  blockedReasons: [], pendingKind: null
});
button.disabled = !presentation.canStart;
buttonLabel.textContent = presentation.label;
status.textContent = presentation.status;
explanation.textContent = presentation.detail;
```

These are **illustrative fixture values**, not usage for a real project. Unavailable controllers must use `online: false`. Missing/old quota must use `fresh: false`, not an invented 100%. Unknown reserves are unknown. `canStart` is a conservative UI hint, never permission: your authenticated backend revalidates all conditions on every write.

## Controller contract

Read status without mutation. A Start request carries a durable, per-project request ID; retry the same request after a lost response. Coalesce rapid clicks. An accepted request is not proof that a worker is running. Read back actual state. Pause must fence late Start results. Stop and emergency scope must be explicit. Unknown delivery must not replay a prompt. Returning fresh quota must not resume a stopped run on its own.

Register and implement an adapter before enabling actions for a new project. The current Hub has production adapters for MJobs and BabyTracker only; copying this UI does **not** make arbitrary Codex, Claude or Gemini runtimes manageable. No universal installer or lifecycle parity is claimed.

## Build / verify

From repository root: `node scripts/build-fleet-ui.js`, then `node scripts/build-fleet-ui.js --check` and `node --test test/fleet-ui.test.js`. Generated prefixes are marked; their bytes are verified by the build. This deliberately uses existing asset routes, so installing UI does not replace native controller code. Update the controller-package hashes when publishing changed package files.

## Deployment boundary

Deploy an exact reviewed revision using an allowlist and verified backups. Preserve private state, source modifications, environment, authentication, database and quota configuration. Never copy a source package over an entire live runtime directory. The native MJobs controller can contain newer runtime-only fixes. The read-only remote monitor links to the protected interactive Hub; it remains GET-only.

## Design provenance

Taste Skill v2.1.5, upstream Leonxlnx/taste-skill commit `12af471f627f866411b4bd785b19646d3672784c`. App-screen run: devtools / dark / seed 20261030 / data-terminal. This implementation is original; no third-party script is loaded by the running dashboard. The main action is a neutral inverted power switch. Amber denotes the quota hold. Font choice was explicitly kept: platform Segoe UI/system plus a system monospace for figures/IDs, avoiding external font requests. A labelled rail replaces an icon-only rail for discoverability; touch controls are at least 44px on phones. These are deliberate usability adjustments, not claims of a perfect automated taste score.
