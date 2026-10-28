param(
    [switch]$EnableSharedServer,
    [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
$aoExe = Join-Path $env:LOCALAPPDATA 'Programs\agent-orchestrator\agent-orchestrator.exe'
$codexExe = Join-Path $env:APPDATA 'npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe'
$configPath = Join-Path $env:USERPROFILE '.codex\config.toml'
$backupDir = 'C:\Tools\AO-Fleet-Control\backups'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$mainAO = @(Get-CimInstance Win32_Process -Filter "Name='agent-orchestrator.exe'" -ErrorAction SilentlyContinue |
    Where-Object { [string]::IsNullOrEmpty($_.CommandLine) -or $_.CommandLine -notmatch ' --type=' })
$aoDaemon = @(Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue)
$pathOkay = (Test-Path -LiteralPath $aoExe) -and (Test-Path -LiteralPath $codexExe)
Write-Host ('Windows token: '+$(if ($elevated) { 'ELEVATED — shared Codex server cannot start' } else { 'STANDARD — eligible for shared Codex server' }))
Write-Host ('AO desktop processes: '+$mainAO.Count+'; existing AO listeners on port 3001: '+$aoDaemon.Count)
Write-Host ('AO installation and Codex binary present: '+$pathOkay)
if($CheckOnly){return}
if($elevated){
    Write-Warning 'Refusing to launch AO as Administrator. Double-click this shortcut from ordinary Windows Explorer, not from an Administrator terminal.'
    exit 2
}
if(!$pathOkay){throw 'AO or Codex executable missing. Repair the executable first.'}
if($mainAO.Count -gt 0 -or $aoDaemon.Count -gt 0){
    Write-Warning 'AO is already running. For privilege changes, complete Graceful Wind-Down, exit the AO desktop and stop its daemon before restarting. Existing sessions are not touched.'
    exit 3
}
if($EnableSharedServer){
    if(!(Test-Path -LiteralPath $configPath)){throw 'Codex configuration not found; refusing to change an unknown configuration'}
    $raw=[IO.File]::ReadAllText($configPath)
    $feature=[regex]::Match($raw,'(?ms)^\[features\]\s*\r?\n(?<body>.*?)(?=^\[|\z)')
    if(!$feature.Success){throw 'Expected [features] section missing; leaving Codex configuration unchanged'}
    $body=$feature.Groups['body'].Value
    if($body -notmatch '(?m)^\s*daemon_auto_start\s*=\s*(true|false)\s*(#.*)?$'){
        throw 'Expected daemon_auto_start flag missing or ambiguous; leaving Codex configuration unchanged'
    }
    $alreadyEnabled=([regex]::Match($body,'(?m)^\s*daemon_auto_start\s*=\s*(true|false)').Groups[1].Value -eq 'true')
    if(!$alreadyEnabled){
        New-Item -ItemType Directory -Path $backupDir -Force|Out-Null
        $stamp=Get-Date -Format 'yyyyMMdd-HHmmss'
        $backup=Join-Path $backupDir "codex-config-before-shared-server-$stamp.toml"
        Copy-Item -LiteralPath $configPath -Destination $backup -ErrorAction Stop
        $newBody=[regex]::Replace($body,'(?m)^(\s*daemon_auto_start\s*=\s*)false', [Text.RegularExpressions.MatchEvaluator]{param($m) $m.Groups[1].Value + 'true'})
        $updated=$raw.Substring(0,$feature.Groups['body'].Index)+$newBody+$raw.Substring($feature.Groups['body'].Index+$feature.Groups['body'].Length)
        $temp=$configPath+'.fleet-temp'
        [IO.File]::WriteAllText($temp,$updated,[Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temp -Destination $configPath -Force
        Write-Host "Enabled Codex shared background server; config backup: $backup" -ForegroundColor Green
    }else{
        Write-Host 'Codex shared background server is already enabled.' -ForegroundColor Green
    }
}
Start-Process -FilePath $aoExe -WorkingDirectory (Split-Path $aoExe)
Write-Host 'Orchestrator.inc started from a standard user token.' -ForegroundColor Green
Write-Host 'Confirm the AO daemon and Codex terminals are non-elevated after sessions resume.'
