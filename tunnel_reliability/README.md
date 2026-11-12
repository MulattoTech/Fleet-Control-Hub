# M-TechLabs cloudflared tunnel reliability (Windows)

Operational source for the current **MulattoTechBox** Fleet Control and Fortnite
Cloudflare connectors. This does not provision a second connector or change any
Cloudflare routes. Keep these source files in Git; runtime state/logs stay under
the user's `%LOCALAPPDATA%` and must never be committed.

## What is protected

- `Cloudflare.cloudflared` is ignored by UniGetUI's automatic package updater.
  Install future connector upgrades deliberately, then verify both tasks and
  Cloudflare connections. The `--no-autoupdate` flag does **not** stop WinGet.
- Cloudflare's existing `M-TechLabs Core Tunnel Health` notification policy
  includes Fleet Control and Fortnite in addition to the main service and
  Windows Docker tunnels. It sends off-host health alerts.
- A separate Windows scheduled task runs `cloudflared_watchdog.py` through
  `pythonw.exe` every two minutes. It monitors each tunnel's *specific*
  token-file command line, task state and local origin TCP port.
- It restarts a task only after its own connector has been absent for at least
  two minutes. It waits for MSI/WinGet cloudflared installers and never restarts
  a running connector simply because its network or origin is unhealthy.
- Restart attempts are limited to three per 30 minutes, separated by five
  minutes. Disabled/deleted tasks are never re-enabled automatically. Disable
  the corresponding task before migrating that connector to a new homelab host.

## Installation / verification

Run from a PowerShell session as the user who owns the existing tunnel tasks:

```powershell
python .\tunnel_reliability\test_cloudflared_watchdog.py
powershell.exe -NoProfile -File .\tunnel_reliability\install_tunnel_watchdog.ps1 -DryRun
powershell.exe -NoProfile -File .\tunnel_reliability\install_tunnel_watchdog.ps1
& "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe" "$env:LOCALAPPDATA\MTechLabs\TunnelHealth\cloudflared_watchdog.py" --check-only
```

Deploy `start_fleet_tunnel.ps1` to the existing
`%LOCALAPPDATA%\FleetControlHub\start-tunnel.ps1` path. Existing scheduled-task
actions do not need to be rewritten. Deploying the file does not restart any
currently running connector; it takes effect on the next scheduled start.

## Logs

- Fleet cloudflared stderr/stdout: `%LOCALAPPDATA%\FleetControlHub\logs\cloudflared\cloudflared-*.log`
- Fleet launcher lifecycle: `%LOCALAPPDATA%\FleetControlHub\logs\cloudflared\launcher-events.jsonl`
- Watchdog status/state: `%LOCALAPPDATA%\MTechLabs\TunnelHealth\state.json`
- Watchdog transitions and recovery attempts: `%LOCALAPPDATA%\MTechLabs\TunnelHealth\events.jsonl`
- Watchdog errors: `%LOCALAPPDATA%\MTechLabs\TunnelHealth\watchdog-errors.log`

Logs are intentionally retained without automatic deletion, to preserve
forensic evidence. Review storage periodically and archive old logs deliberately.
No credentials or token contents are written by these scripts.

## Runbook

1. Check Cloudflare Tunnel status and off-host alert notifications.
2. Run the local `--check-only` command above, without changing anything.
3. Confirm Windows tasks `Fleet Control Tunnel`, `M-TechLabs Fortnite Tunnel`
   and `M-TechLabs - Cloudflare Tunnel Watchdog` are enabled and working.
4. Read the most recent tunnel log files and watchdog events. If the watchdog
   is rate-limited, fix the underlying issue before triggering a manual restart.
5. For deliberate connector upgrades, pause the *watchdog* scheduled task
   before maintenance, perform the upgrade, verify both routes, then re-enable
   the watchdog. When moving a tunnel to another host, disable its *old*
   tunnel task so it is not automatically recovered there.

The Cloudflare dashboard can report a tunnel as healthy even when its local
origin is unreachable; the watchdog separately reports TCP port reachability
without restarting healthy cloudflared processes.
