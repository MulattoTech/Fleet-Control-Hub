param(
  [switch]$NoBrowser,
  [ValidateSet('BabyTracker - Fleet Control','MJobs Fleet - Dashboards Standard','Fleet Control Hub')]
  [ValidateCount(3,3)][string[]]$DashboardTaskNames = @('BabyTracker - Fleet Control','MJobs Fleet - Dashboards Standard','Fleet Control Hub'),
  [ValidatePattern('^\\(?:[^\\:*?"<>|\x00-\x1f]+\\)*$')][string]$DashboardTaskPath = '\',
  [ValidateRange(1024,65535)][int]$HubPort = 4320,
  [ValidateRange(1024,65535)][int]$BabyTrackerPort = 4319,
  [ValidateRange(1024,65535)][int]$MJobsFleetPort = 8787,
  [ValidateRange(2,20)][int]$ReadyTimeoutSeconds = 20
)
# Start/reuse dashboard tasks only: no Mission Control bridge, agents, controller
# action POSTs, process takeover, task registration, or automatic retries.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if (@($DashboardTaskNames | Select-Object -Unique).Count -ne 3) { throw 'Choose each dashboard task exactly once.' }
if (@(@($HubPort,$BabyTrackerPort,$MJobsFleetPort) | Select-Object -Unique).Count -ne 3) { throw 'Dashboard ports must be distinct.' }
$hubUrl = "http://127.0.0.1:$HubPort/"
$frequency = [Diagnostics.Stopwatch]::Frequency
function New-Deadline([int]$Seconds) { return [Diagnostics.Stopwatch]::GetTimestamp() + $Seconds * $frequency }
function Read-Health([string]$Uri,[long]$Deadline = 0) {
  if ($Deadline -and $Deadline - [Diagnostics.Stopwatch]::GetTimestamp() -lt $frequency) { return $null }
  try { return Invoke-RestMethod -Uri $Uri -TimeoutSec 1 -MaximumRedirection 0 -ErrorAction Stop } catch { return $null }
}
function Test-Dashboard([string]$Name,[long]$Deadline = 0) {
  if ($Name -eq 'Fleet Control Hub') {
    if ($Deadline -and $Deadline - [Diagnostics.Stopwatch]::GetTimestamp() -lt $frequency) { return $false }
    try {
      $page = Invoke-WebRequest -UseBasicParsing -Uri $hubUrl -TimeoutSec 1 -MaximumRedirection 0 -ErrorAction Stop
      if ($page.StatusCode -ne 200 -or $page.Content -notmatch 'id="fleets"' -or $page.Content -notmatch 'id="mission-control"') { return $false }
      $health = Read-Health "$($hubUrl)api/health" $Deadline
      return ($health.ok -eq $true -and $health.service -eq 'fleet-control-hub' -and
        $health.nativeFleetOrigin -eq 'controller:8787' -and $health.acceptanceSource -eq 'local-canonical-matrices')
    } catch { return $false }
  }
  if ($Name -eq 'BabyTracker - Fleet Control') {
    $health = Read-Health "http://127.0.0.1:$BabyTrackerPort/api/health" $Deadline
    return $health.status -eq 'ok' -and $health.spendingOnPageLoad -eq $false
  }
  if ($Name -eq 'MJobs Fleet - Dashboards Standard') {
    $health = Read-Health "http://127.0.0.1:$MJobsFleetPort/api/health" $Deadline
    return $health.ok -eq $true
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
foreach ($name in $DashboardTaskNames) { $null = Get-DashboardTask $name }
$taskResults = @()
foreach ($name in $DashboardTaskNames) {
  $task = Get-DashboardTask $name
  if ([string]$task.State -eq 'Running' -or (Test-Dashboard $name)) {
    $taskResults += @{ task = $name; result = 'reused' }
    continue
  }
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
if ($pending.Count) { throw "Fleet workspace is not ready after $ReadyTimeoutSeconds seconds: $($pending -join ', '). Check dashboard tasks/listeners. No agent work was requested and no existing process was stopped." }
if (!$NoBrowser) { Start-Process -FilePath $hubUrl -ErrorAction Stop }
[pscustomobject]@{ ready = $true; url = $hubUrl; dashboards = $taskResults; agentWorkRequested = $false; browserOpened = !$NoBrowser } | ConvertTo-Json -Depth 5 -Compress
