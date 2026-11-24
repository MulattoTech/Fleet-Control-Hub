$ErrorActionPreference = 'Stop'
$launcher = (Resolve-Path "$PSScriptRoot/../scripts/Open-Fleet-Tracker.ps1").Path
$exportRoot = [IO.DirectoryInfo]::new([IO.Path]::GetTempPath()).FullName.TrimEnd('\')
$owner = [Security.Principal.WindowsIdentity]::GetCurrent()
$global:FleetTrackerLauncherFixture = @{
  Task = [pscustomobject]@{
    State = 'Ready'
    Settings = [pscustomobject]@{Enabled = $true; MultipleInstances = 'IgnoreNew'}
    Principal = [pscustomobject]@{UserId = $owner.User.Value; LogonType = 'Interactive'; RunLevel = 'Limited'}
    Actions = @([pscustomobject]@{
      Execute = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
      Arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "{0}" -Monitor -ExportDirectory "{1}"' -f $launcher, $exportRoot
    })
  }
  Starts = 0
  Opens = 0
  Observation = [DateTimeOffset]::UtcNow
}

function Get-ScheduledTask($TaskPath, $TaskName) {
  if ($TaskPath -ne '\' -or $TaskName -ne 'Fleet Control - Tracker Monitor') { throw 'Wrong task target' }
  return $global:FleetTrackerLauncherFixture.Task
}
function Start-ScheduledTask($InputObject) {
  if ($InputObject -ne $global:FleetTrackerLauncherFixture.Task) { throw 'Wrong task instance' }
  $global:FleetTrackerLauncherFixture.Starts++
  $InputObject.State = 'Running'
}
function Invoke-RestMethod($Uri, $TimeoutSec, $MaximumRedirection) {
  if ($Uri -ne 'http://127.0.0.1:20800/mission-control/analytics/desktop-activity.json' -or
      $MaximumRedirection -ne 0) { throw 'Incorrect health route' }
  return @{schema_version = 1; projects = @(@{
    status = 'fresh'
    observed_at = $global:FleetTrackerLauncherFixture.Observation.ToString('o')
    max_age_seconds = 30
  })}
}
function Start-Process($FilePath) {
  if ($FilePath -ne 'https://m-techlabs.com/mission-control/analytics/') { throw 'Incorrect browser destination' }
  if ($global:FleetTrackerLauncherFixture.Starts -eq 0) { throw 'Browser opened before starting the monitor' }
  $global:FleetTrackerLauncherFixture.Opens++
}
function Assert-Counts($Starts, $Opens) {
  $fixture = $global:FleetTrackerLauncherFixture
  if ($fixture.Starts -ne $Starts -or $fixture.Opens -ne $Opens) { throw 'Unexpected launch counts' }
}
function Assert-Fails($Message) {
  try { & $launcher -ExportDirectory $exportRoot -ReadyTimeoutSeconds 5 }
  catch { if ($_.Exception.Message.StartsWith($Message)) { return }; throw }
  throw 'Launcher succeeded unexpectedly'
}

try {
  $fixture = $global:FleetTrackerLauncherFixture
  & $launcher -ExportDirectory $exportRoot
  Assert-Counts 1 1
  $fixture.Task.Principal.UserId = $owner.Name
  & $launcher -ExportDirectory $exportRoot
  Assert-Counts 1 2
  & $launcher -ExportDirectory $exportRoot -NoBrowser
  Assert-Counts 1 2
  $fixture.Observation = [DateTimeOffset]::UtcNow.AddMinutes(-1)
  Assert-Fails 'Fleet Control did not report a fresh Desktop observation.'
  Assert-Counts 1 3
  $fixture.Task.Settings.MultipleInstances = 'Parallel'
  Assert-Fails 'The installed tracker monitor task does not match'
  Assert-Counts 1 4
  $fixture.Task.Settings.MultipleInstances = 'IgnoreNew'
  $fixture.Task.Principal.UserId = 'S-1-5-18'
  Assert-Fails 'The installed tracker monitor task does not match'
  Assert-Counts 1 5
  $fixture.Task.Principal.UserId = $owner.User.Value
  $fixture.Task.Actions[0].Arguments += ' -UnexpectedArgument'
  Assert-Fails 'The installed tracker monitor task does not match'
  Assert-Counts 1 6
  Write-Output 'Fleet Tracker launcher checks passed.'
} finally {
  Remove-Variable -Name FleetTrackerLauncherFixture -Scope Global
}
