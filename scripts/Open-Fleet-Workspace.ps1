param(
  [switch]$NoBrowser,
  [ValidateSet('BabyTracker - Fleet Control','Fleet Control Hub')]
  [ValidateCount(2,2)][string[]]$DashboardTaskNames = @('BabyTracker - Fleet Control','Fleet Control Hub'),
  [ValidatePattern('^\\(?:[^\\:*?"<>|\x00-\x1f]+\\)*$')][string]$DashboardTaskPath = '\',
  [ValidateRange(1024,65535)][int]$HubPort = 4320,
  [ValidateRange(1024,65535)][int]$BabyTrackerPort = 4319,
  [ValidateRange(2,20)][int]$ReadyTimeoutSeconds = 20
)
# One Hub task owns Fleet Control and its embedded MJobs controller.
# No separate native dashboard task or legacy HTTP listener is launched.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if (@($DashboardTaskNames | Select-Object -Unique).Count -ne 2) { throw 'Choose each dashboard task exactly once.' }
if ($HubPort -eq $BabyTrackerPort) { throw 'Dashboard ports must be distinct.' }
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
      $native = Read-Health "$($hubUrl)fleet/api/health" $Deadline
      return ($health.ok -eq $true -and $health.service -eq 'fleet-control-hub' -and
        $health.nativeFleetOrigin -eq 'embedded:in-process' -and $health.acceptanceSource -eq 'local-canonical-matrices' -and
        $native.ok -eq $true -and $native.port -eq $HubPort)
    } catch { return $false }
  }
  if ($Name -eq 'BabyTracker - Fleet Control') {
    $health = Read-Health "http://127.0.0.1:$BabyTrackerPort/api/health" $Deadline
    return $health.status -eq 'ok' -and $health.spendingOnPageLoad -eq $false
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
