$ErrorActionPreference='Stop'
$folder=Join-Path ([IO.Path]::GetTempPath()) ('ao-watchdog-safe-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $folder|Out-Null
try{
 [IO.File]::WriteAllText((Join-Path $folder 'emergency-latch.json'),'{"enabled":false}',[Text.UTF8Encoding]::new($false))
 & 'C:\Program Files\PowerShell\7\pwsh.exe' -NoProfile -NonInteractive -File 'C:\Tools\AO-Fleet-Control\Emergency-Stop-Codex.ps1' -Root $folder
 if($LASTEXITCODE -ne 0){throw 'Inactive watchdog should exit successfully'}
 $file=Join-Path $folder 'emergency-status.json'
 $state=Get-Content $file -Raw|ConvertFrom-Json
 if($state.active -or $state.phase -ne 'disarmed'){throw 'Watchdog did not acknowledge disarm'}
 $bytes=[IO.File]::ReadAllBytes($file)
 if($bytes.Length -gt 2 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191){throw 'JSON has a BOM incompatible with old readers'}
 'PASS: unlatched watchdog acknowledged disarm, no processes targeted, BOM-free JSON.'
}finally{Remove-Item -LiteralPath $folder -Recurse -Force}
