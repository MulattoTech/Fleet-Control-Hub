param([switch]$DryRun)

$ErrorActionPreference = 'Stop'
$taskName = 'M-TechLabs - Cloudflare Tunnel Watchdog'
$repoScripts = $PSScriptRoot
$pythonw = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\pythonw.exe'
$python = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'
$appDir = Join-Path $env:LOCALAPPDATA 'MTechLabs\TunnelHealth'
$watchdogSource = Join-Path $repoScripts 'cloudflared_watchdog.py'
$watchdogTarget = Join-Path $appDir 'cloudflared_watchdog.py'

foreach ($source in @($watchdogSource)) {
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Required source missing: $source" }
}
if (-not (Test-Path -LiteralPath $pythonw)) { throw "pythonw.exe is not installed: $pythonw" }
if (-not (Test-Path -LiteralPath $python)) { throw "python.exe is not installed: $python" }

# Validate the deployed script before changing the scheduled task.
& $python -m py_compile $watchdogSource
if ($LASTEXITCODE -ne 0) { throw 'Watchdog Python syntax validation failed.' }
& $python $watchdogSource --check-only
if ($LASTEXITCODE -ne 0) { throw 'Watchdog preflight failed; no task registration attempted.' }

$action = New-ScheduledTaskAction -Execute $pythonw -Argument ('"' + $watchdogTarget + '"') -WorkingDirectory $appDir
$daily = New-ScheduledTaskTrigger -Daily -At '00:00'
# The daily trigger has a null Repetition instance by default. Reuse the
# well-formed repetition object produced by the once-trigger constructor.
$repeatTemplate = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 2) -RepetitionDuration (New-TimeSpan -Days 1)
$daily.Repetition = $repeatTemplate.Repetition
$daily.Repetition.StopAtDurationEnd = $false
$logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
  -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 1) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId ($env:USERDOMAIN + '\' + $env:USERNAME) `
  -LogonType Interactive -RunLevel Limited
if ($DryRun) {
  Write-Output "DRY RUN: Would install $watchdogTarget and register $taskName"
  Write-Output "DRY RUN: Recurrence $($daily.Repetition.Interval), duration $($daily.Repetition.Duration)"
  return
}

New-Item -ItemType Directory -Path $appDir -Force | Out-Null
Copy-Item -LiteralPath $watchdogSource -Destination $watchdogTarget -Force
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($daily, $logon) `
  -Settings $settings -Principal $principal -Description `
  'Checks Fleet and Fortnite tunnel processes every 2 minutes; controlled restart after 2-minute absence.' -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

$task = Get-ScheduledTask -TaskName $taskName
Write-Output "INSTALLED: $($task.TaskName) ($($task.State)); script=$watchdogTarget"
