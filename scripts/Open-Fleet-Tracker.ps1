[CmdletBinding(DefaultParameterSetName = 'Open')]
param(
  [Parameter(Mandatory)][string]$ExportDirectory,
  [Parameter(Mandatory, ParameterSetName = 'Monitor')][switch]$Monitor,
  [Parameter(ParameterSetName = 'Open')][switch]$NoBrowser,
  [Parameter(ParameterSetName = 'Open')][ValidateRange(5, 45)][int]$ReadyTimeoutSeconds = 25
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$dashboard = 'https://m-techlabs.com/mission-control/analytics/'
$activityUrl = 'http://127.0.0.1:20800/mission-control/analytics/desktop-activity.json'
$taskName = 'Fleet Control - Tracker Monitor'

function Test-LiveObservation {
  try {
    $report = Invoke-RestMethod -Uri $activityUrl -TimeoutSec 2 -MaximumRedirection 0
    if ($report.schema_version -ne 1) { return $false }
    foreach ($observation in $report.projects) {
      if ($observation.status -ne 'fresh' -or !$observation.observed_at -or
          $observation.max_age_seconds -lt 1 -or $observation.max_age_seconds -gt 30) { continue }
      $age = ([DateTimeOffset]::UtcNow - [DateTimeOffset]$observation.observed_at).TotalSeconds
      if ($age -ge -10 -and $age -le $observation.max_age_seconds) { return $true }
    }
  } catch { return $false }
  return $false
}

try {
  $directory = Get-Item -LiteralPath $ExportDirectory
  if (!$directory.PSIsContainer -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'The tracker export destination must be an existing real directory.'
  }
  if ($Monitor) {
    $node = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
    $exporter = Join-Path $PSScriptRoot '..\tools\export-fleet-tracker.js'
    & $node $exporter --output $directory.FullName --watch
    if ($LASTEXITCODE -ne 0) { throw "Fleet Control exporter exited with code $LASTEXITCODE." }
    return
  }

  $task = Get-ScheduledTask -TaskPath '\' -TaskName $taskName
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $taskOwner = $task.Principal.UserId
  if ($taskOwner -notmatch '^S-1-\d+(-\d+)+$') {
    $taskOwner = [Security.Principal.NTAccount]::new($taskOwner).Translate(
      [Security.Principal.SecurityIdentifier]).Value
  }
  $expectedAction = '-NoProfile -NonInteractive -WindowStyle Hidden -File "{0}" -Monitor -ExportDirectory "{1}"' -f $PSCommandPath, $directory.FullName
  $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  if (!$task.Settings.Enabled -or $task.Settings.MultipleInstances -ne 'IgnoreNew' -or
      $task.Principal.LogonType -ne 'Interactive' -or $task.Principal.RunLevel -ne 'Limited' -or
      $taskOwner -ne $identity.User.Value -or @($task.Actions).Count -ne 1 -or
      $task.Actions[0].Execute -ne $powershell -or $task.Actions[0].Arguments -cne $expectedAction) {
    throw 'The installed tracker monitor task does not match this release and current user.'
  }
  if ($task.State -ne 'Running') { Start-ScheduledTask -InputObject $task }

  $elapsed = [Diagnostics.Stopwatch]::StartNew()
  while ($elapsed.Elapsed.TotalSeconds -lt $ReadyTimeoutSeconds) {
    if (Test-LiveObservation) { return }
    Start-Sleep -Milliseconds 500
  }
  throw 'Fleet Control did not report a fresh Desktop observation. The dashboard shows its last available state.'
} finally {
  if (!$Monitor -and !$NoBrowser) { Start-Process -FilePath $dashboard }
}
