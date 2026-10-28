# Windows startup handoff

The startup helper supports Windows PowerShell 5.1 / PowerShell 7 with Node.js
22+. On 2026-10-27, target-host parsing, registration, hidden task startup,
controller controls and the stop/start recovery sequence passed. Actual reboot
and sign-out/sign-in recovery remain untested. Local JavaScript tests alone are
not the evidence for the Windows results below.

## Verified target-host results — 2026-10-27

- Current-user Limited/Interactive task registered with an at-logon trigger and
  IgnoreNew; its running listener binds only to `127.0.0.1:4319`.
- Existing task ownership is resolved to the current SID. Windows normalized
  the principal to a short account name; exact SID resolution verified identity
  without relaxing the owner check.
- With the wrapper guard installed, `Stop-ScheduledTask` removed its owned Node
  supervisor, controller and listener. Starting again restored paused state and
  the existing unassigned OCR issue proposal. A repeated start was ignored and
  did not replace the listener process.
- Start refused absent project workers after the verified project/quota checks.
  Emergency Stop remained latched through Pause and Graceful Stop; explicit
  release required verified zero project sessions. Controller restart changed
  its instance token, preserved the proposal and remained paused.
- There were zero BabyTracker worker sessions and zero provider dispatches.
  The other projects' session-ID set was unchanged during the installed control
  check. Shared-account quota was read, never modified.

The tested runtime/installer revision was `3490b1d59c46544c2d83acc1555b428017949892`.
Its [hosted fleet tests] and [deployment validation] passed. The suite contains
41 tests, with an independent rerun of the nine lifecycle tests. These checks do
not establish dynamic worker provisioning, live-worker kill acceptance, actual
model replacement or reboot recovery.

## Review, register, then test

For the isolated checkout and state paths selected for this deployment:

```powershell
& 'C:\Tools\Dev\BabyTracker-Fleet\tools\fleet-control\Install-BabyTrackerFleetStartup.ps1' `
  -StateDirectory 'C:\Tools\BabyTracker-Fleet-State' `
  -SourceDirectory 'C:\Tools\Dev\BabyTracker' `
  -QuotaFile 'C:\Tools\AO-Fleet-Control\quota-guard-status.json' `
  -WhatIf
```

After reviewing the exact paths/task identity, repeat without `-WhatIf` to
register **BabyTracker - Fleet Control**. Registration does not start the task.
No admin prompt or elevated principal is requested. If local policy denies
current-user registration, the command fails; it does not elevate or change
policy. Existing unrelated tasks and differing launcher/config files are
preserved. Existing matching config is never overwritten.

The initial `fleet.env` has `BABYTRACKER_AO_PROJECT_VERIFIED=0`. After independently
verifying the actual AO `babytracker` project points to the expected source
repository/path, the operator may edit that line in the **state directory**.
The installer cannot certify that binding and has no switch that claims to do so.
Reading a quota path does not mutate or launch its monitor.

Use these read-only checks after registration:

```powershell
Get-ScheduledTask -TaskName 'BabyTracker - Fleet Control' |
  Select-Object TaskName, State, Principal, Actions, Triggers
Get-ScheduledTaskInfo -TaskName 'BabyTracker - Fleet Control'
```

After runtime review, start the task explicitly and check its health:

```powershell
Start-ScheduledTask -TaskName 'BabyTracker - Fleet Control'
Invoke-RestMethod 'http://127.0.0.1:4319/api/health'
```

Expected health is project `babytracker`, mode `paused`, and
`spendingOnPageLoad=false`. A preserved emergency latch instead reports
`emergency` and must remain authoritative. Verify the actual listener is bound to
`127.0.0.1`, the dashboard has no fake agents, no unexpected terminal windows
appear, and task state is Running while the controller remains active.

This is **at-sign-in** startup under the current user's interactive token. It is
not a boot-before-login service. Neither reboot nor sign-out/sign-in recovery is
considered tested merely because task registration or manual startup succeeds.

## Manual hidden launch / diagnostics

After the helper prepares `fleet.env` and `start-hidden.vbs`, the same hidden
launcher can be started manually without changing task registration:

```powershell
& "$env:WINDIR\System32\wscript.exe" //B //Nologo 'C:\Tools\BabyTracker-Fleet-State\start-hidden.vbs'
```

For visible startup diagnostics, use the existing Node executable directly:

```powershell
node --env-file='C:\Tools\BabyTracker-Fleet-State\fleet.env' `
  'C:\Tools\Dev\BabyTracker-Fleet\tools\fleet-control\run.js'
```

Do not start a second instance for diagnostics while the task is already healthy.
The state-directory lock rejects duplicate controllers; the task additionally
uses IgnoreNew. Inspect the scheduled-task result and project audit file if
startup fails; never delete a live controller lock or stop unrelated Node/Codex
processes. The wrapper waits for its own Node supervisor so the scheduled task
does not misleadingly finish while its controller continues running.

The wrapper clears only inherited `BABYTRACKER_*` configuration keys in its own
process environment before Node reads `fleet.env`. This prevents an unrelated
inherited flag from overriding the explicit saved configuration. It changes no
user-wide or machine-wide environment settings.

## Scheduled-task stop and wrapper lifetime

The first target-machine check found that `Stop-ScheduledTask` terminated the
WScript action but left its Node supervisor/controller running. A subsequent
start then correctly failed the existing-controller lock instead of applying
new environment settings. Task state alone was therefore insufficient shutdown
evidence.

The updated launcher sets `BABYTRACKER_FLEET_WRAPPER_WATCH=1` only in its child
process environment. On Windows, the supervisor captures its original parent
PID and checks existence every two seconds using a signal-0 read probe. A verified
`ESRCH` result cancels its watcher/restart timer and stops only its own controller
ChildProcess. Permission or unknown probe errors do not establish parent death
and never trigger a process sweep. Manual Node launches do not enable this guard
by default.

This guard passed local lifecycle tests and the target-host stop/start sequence
recorded above. After stopping the task, verify the owned Node processes have
exited and the listener disappeared before starting again. Do not terminate
unrelated Node/Codex processes. PID existence checks
cannot identify a PID reused by another process; unresolved ownership must be
investigated explicitly.

The installer deliberately refuses to overwrite an existing differing launcher.
When updating an already-installed older wrapper, stop and verify the owned
controller, preserve the old wrapper for recovery, then explicitly replace only
that verified BabyTracker launcher with the reviewed version. Preserve `fleet.env`
and all controller/task state. Do not claim reboot or sign-in recovery from this
stop/start test.

[hosted fleet tests]: https://github.com/MulattoTech/BabyTracker/actions/runs/40457750019
[deployment validation]: https://github.com/MulattoTech/BabyTracker/actions/runs/40457750006
