param(
  [switch]$NoBrowser,
  [ValidateSet('BabyTracker - Fleet Control','MJobs Fleet - Dashboards Standard','Fleet Control Hub')]
  [ValidateCount(3,3)][string[]]$DashboardTaskNames = @('BabyTracker - Fleet Control','MJobs Fleet - Dashboards Standard','Fleet Control Hub'),
  [ValidatePattern('^\\(?:[^\\:*?"<>|\x00-\x1f]+\\)*$')][string]$DashboardTaskPath = '\',
  [ValidateRange(1024,65535)][int]$HubPort = 4320,
  [ValidateRange(1024,65535)][int]$BabyTrackerPort = 4319,
  [ValidateRange(1024,65535)][int]$MJobsFleetPort = 8787,
  [ValidateRange(1024,65535)][int]$MJobsBridgePort = 18729,
  [ValidateRange(1024,65535)][int]$MissionPort = 18726,
  [string]$MissionLauncherPath = 'C:\Tools\Dev\MJobs\Start-MJobs-MissionControl.ps1',
  [string]$PowerShellPath = (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'),
  [ValidateRange(2,20)][int]$ReadyTimeoutSeconds = 20,
  [ValidateRange(2,90)][int]$MissionTimeoutSeconds = 80
)
# Dashboard startup only. No Fleet Start/control POSTs, worker launches, policy
# changes, process takeovers, task registration, or automatic retry of failures.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if (@($DashboardTaskNames | Select-Object -Unique).Count -ne 3) { throw 'Choose each of the three dashboard tasks exactly once.' }
if (@(@($HubPort,$BabyTrackerPort,$MJobsFleetPort,$MJobsBridgePort,$MissionPort) | Select-Object -Unique).Count -ne 5) { throw 'Dashboard ports must be distinct.' }
function Resolve-LocalLauncher([string]$Value,[string[]]$Extensions) {
  if ($Value -notmatch '^[A-Za-z]:[\\/]' -or $Value -match '["\x00-\x1f]' -or !(Test-Path -LiteralPath $Value -PathType Leaf)) { throw "Local launcher file is missing or unsafe: $Value" }
  $resolved = (Resolve-Path -LiteralPath $Value).ProviderPath
  if ([IO.Path]::GetExtension($resolved) -notin $Extensions) { throw "Unexpected launcher file type: $resolved" }
  return $resolved
}
$missionLauncher = Resolve-LocalLauncher $MissionLauncherPath @('.ps1')
$powershell = Resolve-LocalLauncher $PowerShellPath @('.exe')
if ([IO.Path]::GetFileName($powershell) -notin @('powershell.exe','pwsh.exe')) { throw 'Use an installed PowerShell executable, not an arbitrary command.' }
$hubUrl = "http://127.0.0.1:$HubPort/"
$frequency = [Diagnostics.Stopwatch]::Frequency
function New-Deadline([int]$Seconds) { return [Diagnostics.Stopwatch]::GetTimestamp() + $Seconds * $frequency }
function Read-Health([string]$Uri,[long]$Deadline = 0) {
  # Reserve a full one-second request budget rather than overrun the deadline.
  if ($Deadline -and $Deadline - [Diagnostics.Stopwatch]::GetTimestamp() -lt $frequency) { return $null }
  try { return Invoke-RestMethod -Uri $Uri -TimeoutSec 1 -MaximumRedirection 0 -ErrorAction Stop } catch { return $null }
}
function Test-Dashboard([string]$Name,[long]$Deadline = 0) {
  if ($Name -eq 'Fleet Control Hub') {
    if ($Deadline -and $Deadline - [Diagnostics.Stopwatch]::GetTimestamp() -lt $frequency) { return $false }
    try {
      $page = Invoke-WebRequest -UseBasicParsing -Uri $hubUrl -TimeoutSec 1 -MaximumRedirection 0 -ErrorAction Stop
      return $page.StatusCode -eq 200 -and $page.Content -match 'id="fleets"' -and $page.Content -match 'id="mission-control"'
    } catch { return $false }
  }
  if ($Name -eq 'BabyTracker - Fleet Control') {
    $health = Read-Health "http://127.0.0.1:$BabyTrackerPort/api/health" $Deadline
    return $health.status -eq 'ok' -and $health.spendingOnPageLoad -eq $false
  }
  if ($Name -eq 'MJobs Fleet - Dashboards Standard') {
    $fleet = Read-Health "http://127.0.0.1:$MJobsFleetPort/api/health" $Deadline
    $bridge = Read-Health "http://127.0.0.1:$MJobsBridgePort/api/launcher/health" $Deadline
    return $fleet.ok -eq $true -and $bridge.service -eq 'mjobs-mission-control' -and $bridge.fleet_control_path -eq '/fleet/'
  }
  if ($Name -eq 'Standalone Mission Control') {
    $health = Read-Health "http://127.0.0.1:$MissionPort/api/launcher/health" $Deadline
    if ($health.service -ne 'mjobs-mission-control' -or $health.version -lt 8 -or $health.console_output_binding -ne 'CONOUT$') { return $false }
    foreach ($flag in @('prompt_preview','approval_required','history_available','visible_terminal','subagent_controls','prompt_via_stdin','python_environment_preflight','accurate_partial_state','crlf_summary_fix')) {
      if ($health.$flag -ne $true) { return $false }
    }
    return $true
  }
  throw "Unknown dashboard identity: $Name"
}
function Get-DashboardTask([string]$Name) {
  $found = @(Get-ScheduledTask -TaskName $Name -TaskPath $DashboardTaskPath -ErrorAction Stop)
  if ($found.Count -ne 1) { throw "Exactly one existing dashboard task is required: $Name" }
  $task = $found[0]
  if (!$task.Settings.Enabled -or [string]$task.State -eq 'Disabled') { throw "Dashboard task is disabled: $Name" }
  if ([string]$task.Settings.MultipleInstances -ne 'IgnoreNew') { throw "Dashboard task must use IgnoreNew before this launcher can safely reuse it: $Name" }
  return $task
}
# Preflight every task before requesting any startup. Running tasks and healthy
# listeners are reused; a Ready task can still own a healthy detached dashboard.
foreach ($name in $DashboardTaskNames) { $null = Get-DashboardTask $name }
$taskResults = @()
foreach ($name in $DashboardTaskNames) {
  $task = Get-DashboardTask $name
  if ([string]$task.State -eq 'Running' -or (Test-Dashboard $name)) {
    $taskResults += @{ task = $name; result = 'reused' }
    continue
  }
  # Recheck immediately before the request; IgnoreNew handles the remaining race.
  $task = Get-DashboardTask $name
  if ([string]$task.State -ne 'Running') { Start-ScheduledTask -InputObject $task -ErrorAction Stop }
  $taskResults += @{ task = $name; result = 'startup requested' }
}
$deadline = New-Deadline $ReadyTimeoutSeconds
$pending = @($DashboardTaskNames)
while ($pending.Count -and [Diagnostics.Stopwatch]::GetTimestamp() -lt $deadline - $frequency) {
  $pending = @($DashboardTaskNames | Where-Object { !(Test-Dashboard $_ $deadline) })
  if ($pending.Count) { Start-Sleep -Milliseconds 200 }
}
if ($pending.Count) { throw "Fleet workspace is not ready after $ReadyTimeoutSeconds seconds: $($pending -join ', '). Check those dashboard tasks/listeners. No agent work was requested and no existing process was stopped." }
$missionLock = [Threading.Mutex]::new($false,('Local\FleetControlHub.MissionDashboard.' + $MissionPort))
$ownsMissionLock = $false
try {
  try { $ownsMissionLock = $missionLock.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsMissionLock = $true }
  if (!$ownsMissionLock) { throw 'Another Fleet workspace launch is checking or starting Mission Control. Wait for it to finish; no duplicate Mission launcher was started.' }
  $missionReused = Test-Dashboard 'Standalone Mission Control'
  if (!$missionReused) {
    $missionProcess = $null
    try {
      $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "' + $missionLauncher + '" -Port ' + $MissionPort + ' -NoBrowser'
      $missionProcess = Start-Process -FilePath $powershell -ArgumentList $arguments -WorkingDirectory (Split-Path -Parent $missionLauncher) -WindowStyle Hidden -PassThru -ErrorAction Stop
      $deadline = New-Deadline $MissionTimeoutSeconds
      while (!$missionProcess.WaitForExit(200)) {
        if ([Diagnostics.Stopwatch]::GetTimestamp() -ge $deadline - $frequency) {
          # Only our launcher helper is stopped; never its dashboard descendants,
          # existing listeners, native controllers, or workers. Do not retry.
          try { $missionProcess.Kill() } catch { Write-Warning "Mission launcher PID $($missionProcess.Id) could not be stopped; inspect it before retrying." }
          throw "Mission Control startup timed out after $MissionTimeoutSeconds seconds. Dashboard outcome is unverified; inspect the Mission Control bootstrap/server logs before retrying."
        }
      }
      if ($missionProcess.ExitCode -ne 0) { throw "Mission Control launcher exited with code $($missionProcess.ExitCode). Check its bootstrap/server logs and any execution-policy or permission error; no policy was changed." }
      if (!(Test-Dashboard 'Standalone Mission Control' $deadline)) { throw "Mission Control launcher exited, but the expected dashboard health at port $MissionPort is not verified." }
    } finally { if ($missionProcess) { $missionProcess.Dispose() } }
  }
} finally {
  if ($ownsMissionLock) { $missionLock.ReleaseMutex() }
  $missionLock.Dispose()
}
if (!$NoBrowser) { Start-Process -FilePath $hubUrl -ErrorAction Stop }
[pscustomobject]@{ ready = $true; url = $hubUrl; missionUrl = "http://127.0.0.1:$MissionPort/"; missionReused = [bool]$missionReused; dashboards = $taskResults; agentWorkRequested = $false; browserOpened = !$NoBrowser } | ConvertTo-Json -Depth 5 -Compress
