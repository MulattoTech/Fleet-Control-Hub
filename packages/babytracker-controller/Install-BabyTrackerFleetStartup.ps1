[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$StateDirectory = (Join-Path $env:LOCALAPPDATA 'BabyTracker\Fleet'),
    [string]$SourceDirectory = 'C:\Tools\Dev\BabyTracker',
    [ValidateRange(1024, 65535)][int]$Port = 4319,
    [string]$NodeExecutable = '',
    [string]$QuotaFile = ''
)

# Registers only the current interactive user's limited task. Does not start it.
# Windows execution must be verified on the target host before deployment claims.
$ErrorActionPreference = 'Stop'
$taskName = 'BabyTracker - Fleet Control'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if ($identity.IsSystem) { throw 'Run this installer as the intended signed-in user, not SYSTEM.' }
$sid = $identity.User.Value
function Test-CurrentUserIdentity([string]$UserId) {
    try {
        # Task Scheduler may normalize the registered SID to a local short name.
        # Resolve the actual identity instead of weakening the owner check.
        $resolved = if ($UserId -match '^S-\d-') {
            [Security.Principal.SecurityIdentifier]::new($UserId)
        } else {
            ([Security.Principal.NTAccount]::new($UserId)).Translate([Security.Principal.SecurityIdentifier])
        }
        return $resolved.Value -eq $sid
    } catch { return $false }
}
$codeDirectory = [IO.Path]::GetFullPath($PSScriptRoot)
$statePath = [IO.Path]::GetFullPath($StateDirectory).TrimEnd('\')
$sourcePath = [IO.Path]::GetFullPath($SourceDirectory).TrimEnd('\')
if (-not $NodeExecutable) { $NodeExecutable = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source }
$nodePath = (Resolve-Path -LiteralPath $NodeExecutable -ErrorAction Stop).ProviderPath
$runPath = Join-Path $codeDirectory 'run.js'
$wscriptPath = Join-Path $env:WINDIR 'System32\wscript.exe'
foreach ($required in @($runPath, (Join-Path $codeDirectory 'server.js'), $nodePath, $wscriptPath)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required file is missing: $required" }
}
if (-not (Test-Path -LiteralPath $sourcePath -PathType Container)) { throw 'The configured BabyTracker application checkout does not exist.' }
foreach ($value in @($statePath, $sourcePath, $nodePath, $codeDirectory, $QuotaFile)) {
    if ($value -match '["\r\n#%]') { throw 'Launcher/config paths cannot contain quotes, newlines, # or %.' }
}
if ($statePath -match '(?i)(^|[\\/])(MJobs|AO-Fleet-Control)([\\/]|$)' -or
    $statePath -ieq $codeDirectory -or $statePath.StartsWith($codeDirectory.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or
    $statePath -ieq $sourcePath -or $statePath.StartsWith($sourcePath + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Use an independent BabyTracker state directory outside code, application and MJobs directories.'
}
$nodeVersion = (& $nodePath --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) { throw 'A working Node.js 22+ executable is required.' }
if ($QuotaFile) {
    $QuotaFile = (Resolve-Path -LiteralPath $QuotaFile -ErrorAction Stop).ProviderPath
    if (-not (Test-Path -LiteralPath $QuotaFile -PathType Leaf)) { throw 'The read-only quota snapshot is missing.' }
}

$envFile = Join-Path $statePath 'fleet.env'
$launcherFile = Join-Path $statePath 'start-hidden.vbs'
$description = "BabyTracker Fleet Control v1; owner=$sid; state=$statePath"
$actionArguments = '//B //Nologo "' + $launcherFile + '"'
$existing = Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction SilentlyContinue
if ($existing) {
    $actions = @($existing.Actions)
    $triggers = @($existing.Triggers)
    if ($existing.Description -ne $description -or
        -not (Test-CurrentUserIdentity $existing.Principal.UserId) -or
        [string]$existing.Principal.RunLevel -ne 'Limited' -or [string]$existing.Principal.LogonType -ne 'Interactive' -or
        $actions.Count -ne 1 -or $actions[0].Execute -ine $wscriptPath -or $actions[0].Arguments -ne $actionArguments -or
        $triggers.Count -ne 1 -or $triggers[0].CimClass.CimClassName -ne 'MSFT_TaskLogonTrigger' -or -not (Test-CurrentUserIdentity $triggers[0].UserId) -or
        [string]$existing.Settings.MultipleInstances -ne 'IgnoreNew' -or $existing.Settings.ExecutionTimeLimit -ne 'PT0S') {
        throw 'A different same-name task exists. It was preserved; inspect it before choosing a migration.'
    }
}

$configLines = @(
    "BABYTRACKER_FLEET_STATE=$statePath",
    "BABYTRACKER_SOURCE_PATH=$sourcePath",
    "BABYTRACKER_FLEET_PORT=$Port",
    'BABYTRACKER_AO_PROJECT_VERIFIED=0'
)
if ($QuotaFile) { $configLines += "BABYTRACKER_CODEX_QUOTA_FILE=$QuotaFile" }
$configText = ($configLines -join "`r`n") + "`r`n"
if (Test-Path -LiteralPath $envFile) {
    $existingConfig = [IO.File]::ReadAllLines($envFile)
    $seenKeys = @{}
    foreach ($line in $existingConfig) {
        if ($line -match '^\s*(?:export\s+)?(BABYTRACKER_[A-Za-z0-9_]+)\s*=') {
            $key = $Matches[1].ToUpperInvariant()
            if ($seenKeys.ContainsKey($key)) { throw 'Existing fleet.env has duplicate BabyTracker configuration keys. It was preserved.' }
            $seenKeys[$key] = $true
        }
    }
    $requiredLines = @($configLines[0..2])
    if ($QuotaFile) { $requiredLines += "BABYTRACKER_CODEX_QUOTA_FILE=$QuotaFile" }
    foreach ($requiredLine in $requiredLines) {
        if ($existingConfig -notcontains $requiredLine) { throw 'Existing fleet.env differs from the requested state/source/port or explicit quota path. It was preserved.' }
    }
}

$commandLine = '"' + $nodePath + '" --env-file="' + $envFile + '" "' + $runPath + '"'
$vbsCommand = $commandLine.Replace('"', '""')
$vbsDirectory = $codeDirectory.Replace('"', '""')
$launcherText = @"
Option Explicit
Dim shell, environment, name, result
Set shell = CreateObject("WScript.Shell")
Set environment = shell.Environment("Process")
For Each name In Array("BABYTRACKER_FLEET_STATE", "BABYTRACKER_SOURCE_PATH", "BABYTRACKER_FLEET_PORT", "BABYTRACKER_AO_PROJECT_VERIFIED", "BABYTRACKER_AO_URL", "BABYTRACKER_AO_PATH", "BABYTRACKER_CODEX_QUOTA_FILE", "BABYTRACKER_CODEX_EXE", "BABYTRACKER_MODELS_FILE", "BABYTRACKER_FLEET_WRAPPER_WATCH")
    environment.Remove name
Next
environment("BABYTRACKER_FLEET_WRAPPER_WATCH") = "1"
shell.CurrentDirectory = "$vbsDirectory"
result = shell.Run("$vbsCommand", 0, True)
WScript.Quit result
"@
if ((Test-Path -LiteralPath $launcherFile) -and [IO.File]::ReadAllText($launcherFile) -ne $launcherText) {
    throw 'Existing launcher differs from this exact source/node/state binding. It was preserved.'
}

if ($PSCmdlet.ShouldProcess("$taskName for $($identity.Name)", 'Prepare isolated config/hidden launcher and register a limited task at this user logon; do not start')) {
    [IO.Directory]::CreateDirectory($statePath) | Out-Null
    if (-not (Test-Path -LiteralPath $envFile)) { [IO.File]::WriteAllText($envFile, $configText, [Text.UTF8Encoding]::new($false)) }
    if (-not (Test-Path -LiteralPath $launcherFile)) { [IO.File]::WriteAllText($launcherFile, $launcherText, [Text.Encoding]::Unicode) }
    if (-not $existing) {
        $action = New-ScheduledTaskAction -Execute $wscriptPath -Argument $actionArguments -WorkingDirectory $codeDirectory
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $sid
        $principal = New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
        $task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $description
        Register-ScheduledTask -TaskName $taskName -TaskPath '\' -InputObject $task -ErrorAction Stop | Out-Null
    }
    [pscustomobject]@{ TaskName = $taskName; User = $identity.Name; RunLevel = 'Limited'; Trigger = 'At this user sign-in'; StateDirectory = $statePath; Configuration = $envFile; Url = "http://127.0.0.1:$Port"; Started = $false; AgentDispatch = 'Paused on every controller start; new config requires runtime verification' }
}
