# Production entry point for the Fleet Control cloudflared scheduled task.
# Each run gets its own timestamped stdout/stderr files; credentials are never logged.
$ErrorActionPreference = 'Stop'
$base = Join-Path $env:LOCALAPPDATA 'FleetControlHub'
$tokenFile = Join-Path $base 'cloudflared-token'
$cloudflared = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
$logDir = Join-Path $base 'logs\cloudflared'
$eventsPath = Join-Path $logDir 'launcher-events.jsonl'

if (-not (Test-Path -LiteralPath $tokenFile -PathType Leaf)) {
  throw 'Fleet Control tunnel token file is missing.'
}
if (-not (Test-Path -LiteralPath $cloudflared -PathType Leaf)) {
  throw 'cloudflared executable is missing.'
}
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$runId = '{0}-{1}' -f (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ'), $PID
$errorLog = Join-Path $logDir ("cloudflared-$runId.stderr.log")
$outputLog = Join-Path $logDir ("cloudflared-$runId.stdout.log")

function Write-LauncherEvent([string]$eventName, [int]$code, [string]$detail) {
  $obj = [ordered]@{
    utc = (Get-Date).ToUniversalTime().ToString('o')
    event = $eventName
    exitCode = $code
    runId = $runId
    detail = $detail
  }
  ($obj | ConvertTo-Json -Compress -Depth 3) | Add-Content -LiteralPath $eventsPath -Encoding UTF8
}

try {
  Write-LauncherEvent -eventName 'starting' -code 0 -detail 'cloudflared launched through Windows Task Scheduler'
  # -NoNewWindow prevents PowerShell from opening a visible child console.
  # cloudflared writes its normal diagnostics to stderr, which is captured as text.
  $p = Start-Process -FilePath $cloudflared -ArgumentList @(
    'tunnel', '--no-autoupdate', 'run', '--token-file', ('"' + $tokenFile + '"')
  ) -NoNewWindow -RedirectStandardOutput $outputLog -RedirectStandardError $errorLog -Wait -PassThru
  Write-LauncherEvent -eventName 'exited' -code $p.ExitCode -detail 'cloudflared process terminated'
  exit $p.ExitCode
} catch {
  # Do not include native process command lines, environment variables or token contents.
  Write-LauncherEvent -eventName 'launch_failed' -code 1 -detail $_.Exception.GetType().Name
  exit 1
}
