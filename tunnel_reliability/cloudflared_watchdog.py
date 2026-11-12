"""Independent, conservative recovery for the two M-TechLabs Windows tunnels.

Only restarts a scheduled task after its *own* cloudflared child has been absent
for two minutes. A running connector is never killed for a network/origin fault.
Runs from pythonw.exe to avoid flashing console windows.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import traceback
from datetime import datetime, timezone

if os.name == "nt":
    import msvcrt


TASKS = {
    "Fleet Control Tunnel": 4320,
    "M-TechLabs Fortnite Tunnel": 4335,
}
GRACE_SECONDS = 120
MIN_RESTART_SPACING_SECONDS = 300
RESTART_WINDOW_SECONDS = 1800
MAX_RESTARTS_PER_WINDOW = 3
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

SNAPSHOT_PS = r"""
$ErrorActionPreference = 'Stop'
$root = [Environment]::GetFolderPath('LocalApplicationData')
$defs = @(
  @{ Name='Fleet Control Tunnel'; Marker=(Join-Path $root 'FleetControlHub\cloudflared-token') },
  @{ Name='M-TechLabs Fortnite Tunnel'; Marker=(Join-Path $root 'MTechLabs\FortniteStudio\tunnel-token.txt') }
)
$processes = @(Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'")
$installers = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -match '^(msiexec|winget)(\.exe)?$' -and
  $_.CommandLine -match '(?i)Cloudflare\.cloudflared|cloudflared-windows'
})
$targets = @()
foreach ($def in $defs) {
  $task = Get-ScheduledTask -TaskName $def.Name -ErrorAction SilentlyContinue
  $matches = @($processes | Where-Object {
    $_.CommandLine -and
    $_.CommandLine.IndexOf($def.Marker, [StringComparison]::OrdinalIgnoreCase) -ge 0
  })
  $targets += [pscustomobject]@{
    name = $def.Name
    taskState = $(if ($task) { [string]$task.State } else { 'Missing' })
    processCount = $matches.Count
    tokenPresent = [bool](Test-Path -LiteralPath $def.Marker)
  }
}
[pscustomobject]@{ installerActive = ($installers.Count -gt 0); targets = $targets } |
  ConvertTo-Json -Compress -Depth 4
"""

RESTART_PS = r"""
$ErrorActionPreference = 'Stop'
$taskName = '__TASK_NAME__'
$root = [Environment]::GetFolderPath('LocalApplicationData')
$marker = Join-Path $root '__MARKER__'
$installers = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -match '^(msiexec|winget)(\.exe)?$' -and
  $_.CommandLine -match '(?i)Cloudflare\.cloudflared|cloudflared-windows'
})
if ($installers.Count -gt 0) { 'SKIP_INSTALLER_ACTIVE'; exit 0 }
$existing = @(Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" |
  Where-Object { $_.CommandLine -and
    $_.CommandLine.IndexOf($marker, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
if ($existing.Count -gt 0) { 'SKIP_ALREADY_RUNNING'; exit 0 }
if (-not (Test-Path -LiteralPath $marker)) { 'SKIP_MISSING_TOKEN'; exit 0 }
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
if ($task.State -eq 'Disabled') { 'SKIP_DISABLED'; exit 0 }
if ($task.State -eq 'Running') { Stop-ScheduledTask -TaskName $taskName -ErrorAction Stop }
Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
'START_REQUESTED'
"""

MARKERS = {
    "Fleet Control Tunnel": r"FleetControlHub\cloudflared-token",
    "M-TechLabs Fortnite Tunnel": r"MTechLabs\FortniteStudio\tunnel-token.txt",
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def run_powershell(script: str) -> str:
    completed = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
        capture_output=True,
        text=True,
        timeout=35,
        creationflags=NO_WINDOW,
        check=False,
    )
    if completed.returncode:
        raise RuntimeError(
            "PowerShell command failed (exit %d): %s"
            % (completed.returncode, completed.stderr[-600:])
        )
    return completed.stdout.strip()


def snapshot() -> dict:
    raw = json.loads(run_powershell(SNAPSHOT_PS))
    # PowerShell represents singleton arrays inconsistently. Normalize them.
    targets = raw.get("targets", [])
    raw["targets"] = targets if isinstance(targets, list) else [targets]
    return raw


def origin_reachable(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1.5):
            return True
    except OSError:
        return False


def decision(now: float, target: dict, prior: dict, installer_active: bool) -> str:
    """Pure recovery policy, separate from Windows process/task operations."""
    state = target.get("taskState", "Missing")
    if state in ("Missing", "Disabled") or not target.get("tokenPresent", False):
        return "unmanaged"
    if int(target.get("processCount", 0)) > 0:
        return "healthy"
    if installer_active:
        return "installer_active"
    missing_since = prior.get("missing_since")
    if missing_since is None or now - float(missing_since) < GRACE_SECONDS:
        return "grace"
    attempts = [float(x) for x in prior.get("attempts", []) if now - float(x) < RESTART_WINDOW_SECONDS]
    if len(attempts) >= MAX_RESTARTS_PER_WINDOW:
        return "rate_limited"
    if attempts and now - max(attempts) < MIN_RESTART_SPACING_SECONDS:
        return "backoff"
    if state not in ("Ready", "Running"):
        return "task_not_startable"
    return "restart"


def mark_observation(tracked: dict, process_count: int, now: float) -> None:
    """Preserve the beginning of an outage, including after a healthy period."""
    if process_count > 0:
        tracked["missing_since"] = None
        tracked["attempts"] = []
    elif tracked.get("missing_since") is None:
        tracked["missing_since"] = now


def record_event(log_path: Path, name: str, status: str, severity: str = "info", **details: object) -> None:
    entry = {"utc": utc_now(), "task": name, "status": status, "severity": severity, **details}
    with log_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, separators=(",", ":")) + "\n")


def write_state(path: Path, state: dict) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def restart_task(name: str) -> str:
    # Task name and file marker come only from the fixed allowlist above.
    script = RESTART_PS.replace("__TASK_NAME__", name).replace("__MARKER__", MARKERS[name])
    return run_powershell(script).strip()


def check_once(state_dir: Path, dry_run: bool = False, check_only: bool = False) -> dict:
    current = snapshot()
    if check_only:
        for item in current["targets"]:
            item["originReachable"] = origin_reachable(TASKS[item["name"]])
        return current

    state_path = state_dir / "state.json"
    event_path = state_dir / "events.jsonl"
    try:
        state = json.loads(state_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError, OSError):
        state = {"targets": {}}
    now = time.time()
    results = []

    for target in current["targets"]:
        name = target["name"]
        previous = state.setdefault("targets", {}).get(name, {})
        tracked = dict(previous)
        observed = decision(now, target, tracked, bool(current.get("installerActive")))
        origin_ok = origin_reachable(TASKS[name])

        mark_observation(tracked, int(target.get("processCount", 0)), now)

        tracked["attempts"] = [
            float(x) for x in tracked.get("attempts", [])
            if now - float(x) < RESTART_WINDOW_SECONDS
        ]
        effective = observed
        if observed == "restart" and not dry_run:
            tracked["attempts"].append(now)
            try:
                result = restart_task(name)
                effective = "restart_requested" if result == "START_REQUESTED" else result.lower()
                record_event(event_path, name, effective, result=result)
            except Exception as exc:
                effective = "restart_failed"
                record_event(event_path, name, effective, "error", error=str(exc)[-500:])

        if int(target.get("processCount", 0)) > 1:
            effective = "duplicate_connectors"
        if tracked.get("last_status") != effective or tracked.get("last_origin_ok") != origin_ok:
            if not dry_run:
                severity = "warning" if effective not in ("healthy", "grace", "restart_requested") or not origin_ok else "info"
                record_event(event_path, name, effective, severity, processCount=target.get("processCount"),
                             taskState=target.get("taskState"), originPort=TASKS[name], originReachable=origin_ok)

        tracked["last_status"] = effective
        tracked["last_origin_ok"] = origin_ok
        state["targets"][name] = tracked
        results.append({"name": name, "status": effective, "originReachable": origin_ok,
                        "processCount": target.get("processCount"), "taskState": target.get("taskState")})

    state["last_checked_utc"] = utc_now()
    if not dry_run:
        write_state(state_path, state)
    return {"installerActive": current.get("installerActive", False), "targets": results}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="Compute decisions without restarting tasks or writing state")
    parser.add_argument("--check-only", action="store_true", help="Display current state with no changes")
    args = parser.parse_args()
    local_app_data = os.environ.get("LOCALAPPDATA")
    if not local_app_data:
        raise RuntimeError("LOCALAPPDATA is required on this Windows host")
    state_dir = Path(local_app_data) / "MTechLabs" / "TunnelHealth"
    state_dir.mkdir(parents=True, exist_ok=True)

    if args.check_only or args.dry_run:
        print(json.dumps(check_once(state_dir, dry_run=args.dry_run, check_only=args.check_only), indent=2))
        return 0

    lock_path = state_dir / "watchdog.lock"
    with lock_path.open("a+b") as lock:
        lock.seek(0)
        if lock.read(1) != b"1":
            lock.seek(0)
            lock.write(b"1")
            lock.flush()
        lock.seek(0)
        try:
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            return 0  # A previous scheduled invocation is still running.
        try:
            check_once(state_dir)
            return 0
        except Exception:
            with (state_dir / "watchdog-errors.log").open("a", encoding="utf-8") as handle:
                handle.write(utc_now() + " " + traceback.format_exc()[-2500:] + "\n")
            return 1
        finally:
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)


if __name__ == "__main__":
    sys.exit(main())
