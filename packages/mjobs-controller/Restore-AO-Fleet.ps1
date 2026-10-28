param(
 [switch]$Preview,
 [switch]$ResumeDispatch,
 [string]$Confirm
)
$ErrorActionPreference='Stop'
$root='C:\Tools\AO-Fleet-Control'
$start=Join-Path $root 'Start-Fleet-Control.ps1'
$base='http://127.0.0.1:8787'
function IsHealthy {
 try{$r=Invoke-RestMethod -Uri ($base+'/api/health') -TimeoutSec 3;return ($r.ok -eq $true)}
 catch{return $false}
}
if(!(IsHealthy)){
 if(!(Test-Path $start)){throw 'Fleet Control is not installed'}
 & 'C:\Program Files\PowerShell\7\pwsh.exe' -NoProfile -File $start
 foreach($i in 1..10){Start-Sleep -Milliseconds 350;if(IsHealthy){break}}
 if(!(IsHealthy)){throw 'Fleet Control could not be started. See dashboard server logs.'}
}
if($Preview){
 $p=Invoke-RestMethod ($base+'/api/master/restore/preview') -TimeoutSec 25
 Write-Host "Saved targets: $($p.totalTargets); already online: $($p.alreadyOnline); recovery needed: $($p.willResume)"
 Write-Host "Emergency lockout: $($p.emergencyLatched); AO reachable: $($p.liveDaemon)"
 if($p.rootConflicts.Count){Write-Warning "$($p.rootConflicts.Count) root conflict(s) detected. No duplicate roots will launch."}
 return
}
if($Confirm -cne 'RESTORE FLEET'){
 throw 'Explicit confirmation is required. Use -Preview to inspect, or -Confirm "RESTORE FLEET" to proceed.'
}
$body=@{confirm='RESTORE FLEET';autoDispatchAfter=[bool]$ResumeDispatch}|ConvertTo-Json -Compress
$result=Invoke-RestMethod -Uri ($base+'/api/master/restore') -Method Post -Headers @{'X-AO-Fleet'='1'} -ContentType 'application/json' -Body $body -TimeoutSec 30
Write-Host "Restoration: $($result.restore.phase). Expected session runtimes: $($result.restore.total)" -ForegroundColor Green
if($ResumeDispatch){Write-Host 'Sustained automatic dispatch will resume ONLY after all saved runtimes are verified.'}
else{Write-Host 'Automatic dispatch will stay paused after recovery.'}
Write-Host "Track progress: $base"
