[CmdletBinding()]
param([switch]$ValidateOnly)
$ErrorActionPreference='Stop'

function Get-FleetListenerPids {
 # Windows occasionally omits a live socket from a single TCP snapshot.
 # Retry narrowly and accept only a loopback LISTENING owner, never TIME_WAIT.
 for($attempt=0;$attempt -lt 6;$attempt++){
  $netstatPids=@(netstat -ano -p TCP 2>$null | ForEach-Object {
   if($_ -match '^\s*TCP\s+(?:127\.0\.0\.1|\[::1\]):8787\s+\S+\s+LISTENING\s+(\d+)\s*$'){[int]$Matches[1]}
  } | Sort-Object -Unique)
  $tcpPids=@(Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue |
   Where-Object { $_.LocalAddress -in @('127.0.0.1','::1') -and $_.OwningProcess -gt 0 } |
   Select-Object -ExpandProperty OwningProcess -Unique)
  if($netstatPids.Count -and $tcpPids.Count -and @(Compare-Object $netstatPids $tcpPids).Count){
   throw 'Conflicting dashboard listener ownership reports; stop refused'
  }
  if($netstatPids.Count){return $netstatPids}
  if($tcpPids.Count){return $tcpPids}
  if($attempt -lt 5){Start-Sleep -Milliseconds 150}
 }
 return @()
}
function Get-FleetHealth {
 try{$h=Invoke-RestMethod -Uri 'http://127.0.0.1:8787/api/health' -TimeoutSec 2 -ErrorAction Stop}catch{return $null}
 if($h.ok -eq $true -and $h.port -eq 8787 -and $h.host -eq '127.0.0.1'){return $h}
 return $null
}
$pids=@(Get-FleetListenerPids)
if(!$pids.Count){
 if(Get-FleetHealth){throw 'Fleet Control responds on port 8787 but its owning PID cannot be verified; stop refused'}
 Write-Host 'Dashboard is already stopped'
 exit 0
}
if($pids.Count -ne 1){throw 'Multiple candidate dashboard listener PIDs; stop refused'}
foreach($listenerPid in $pids){
 $p=$null
 try{$p=Get-CimInstance Win32_Process -Filter "ProcessId = $listenerPid" -ErrorAction Stop}catch{}
 if($p){
  if($p.Name -ne 'node.exe'){throw "PID $listenerPid is not the expected node.exe; stop refused"}
  if($p.CommandLine -and $p.CommandLine -notlike '*AO-Fleet-Control*server.js*'){
   throw "PID $listenerPid command line is not Fleet Control; stop refused"
  }
 }else{
  $process=Get-Process -Id $listenerPid -ErrorAction Stop
  if($process.ProcessName -ne 'node'){throw "PID $listenerPid is not node.exe; stop refused"}
 }
 if(!(Get-FleetHealth)){throw "Fleet Control health is not verified for listener PID $listenerPid; stop refused"}
 # Re-check ownership immediately before any stop to guard against PID reuse.
 $currentPids=@(Get-FleetListenerPids)
 if($currentPids.Count -ne 1 -or $currentPids[0] -ne $listenerPid){
  throw "Dashboard listener ownership changed before stop; no process was stopped"
 }
 if($ValidateOnly){Write-Host "Verified dashboard server PID $listenerPid; no stop performed";continue}
 Stop-Process -Id $listenerPid -Force -ErrorAction Stop
 Write-Host "Stopped dashboard server PID $listenerPid"
}
