# Turbo toggle repair — October 30, 2026

## Observed fault and implemented repair

The native dashboard rejected a Turbo enable request while Sustained was finishing its dispatch cycle. The browser also drew a successful response while its own `busy` flag was still true, leaving the toggle disabled until the next polling cycle. A status read started before the click could overwrite the newer confirmed mode. The initial HTML could look clickable before controller state had loaded.

The repair makes dispatcher switching an explicit transaction using the existing manual-control lane. It pauses the predecessor's future assignments, waits for its current controller cycle, rechecks native quota/startup/emergency conditions and then enables exactly the requested mode. Running agent turns are not killed. A newer Pause, Stop, Startup cancellation or quota-disarm request cancels a waiting transition. Timeout can restore the prior mode only while that intent and the safety state remain unchanged.

The UI now releases and redraws its controls immediately, rejects outdated status/preview responses, disables its initial toggle until live state arrives, and does not label an ordinary running cycle as a paused scheduler. No quota threshold, cooldown or hourly budget is bypassed.

## Live browser evidence

The installed compatibility patch was exercised through the actual Mission Control route `http://127.0.0.1:18729/fleet/` using a separate owned headless browser profile and pointer clicks. Only three browser POSTs occurred, all to the Turbo-toggle route:

| UTC observation | Action | Verified result |
| --- | --- | --- |
| 2026-10-30 05:43:49.465 | Enable Turbo | Turbo on, Sustained off |
| 2026-10-30 05:43:52.718 | Pause Turbo | Turbo off; toggle immediately usable |
| 2026-10-30 05:44:00.557 | Enable Turbo | Turbo on, Sustained off |
| 2026-10-30 05:44:09.715 | Check after automatic refresh | Turbo still on; button reads Pause Turbo |

The final browser checkpoint recorded 9/9 verified recovery runtimes, one agent actively executing, 31% remaining allowance, and an armed/acknowledged 7% stop guard. Turbo had a fresh successful dispatch at 05:43:51.714Z. No JavaScript exceptions were observed. No restore, agent replacement, merge or quota-change action was performed by the test.

The dashboard service was restarted once to load the backend patch. Exact executable, command line and a newly established loopback connection identified that dashboard process; no native agent was restarted. The existing source checkout had additional controller work not in the live runtime, so the narrow transaction/UI repair was applied separately to each version rather than replacing the entire live controller from this PR.

## Tests and limits

Eight dispatcher-transaction tests and four UI-state tests passed against both the canonical source and staged runtime repair. The complete canonical MJobs regression runner passed 56 of 57 groups. Its unchanged `test-terminal-delivery.js` Windows owner-probe fixture failed because the workstation's CIM TCP-listener query returned no listener for the synthetic process. Production terminal ownership verification was not weakened or the test skipped. Hosted CI must be evaluated on the published head separately.

The independently developed session-lifecycle package is source-only in this delivery: its new scheduled-task installer and page write were blocked, and the old retirement task remains unchanged. A successful Turbo repair does not imply that unattended complex-session retirement has been deployed.
