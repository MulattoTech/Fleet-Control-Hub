param([switch]$OpenBrowser)
$ErrorActionPreference='Stop'
$root='C:\Tools\AO-Fleet-Control'
$node='C:\Program Files\nodejs\node.exe'
$fleetHealth='http://127.0.0.1:8787/api/health'
$destination='http://127.0.0.1:8787/'
$launchMutex=[System.Threading.Mutex]::new($false,'Local\MJobsFleetDashboardLauncher')
$ownsMutex=$false
function Read-Health([string]$uri) {
 try { return Invoke-RestMethod -Uri $uri -TimeoutSec 2 } catch { return $null }
}
try {
 try { $ownsMutex=$launchMutex.WaitOne(10000) } catch [System.Threading.AbandonedMutexException] { $ownsMutex=$true }
 if(!$ownsMutex){throw 'Another dashboard launch is in progress. Wait a moment and retry.'}
 $status=Read-Health $fleetHealth
 if(!$status.ok){
  if(Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue){throw 'Port 8787 is occupied. No process was stopped.'}
  if(!(Test-Path $node)){throw "Node.js not installed: $node"}
  $server=Join-Path $root 'server.js'
  if(!(Test-Path $server)){throw "Dashboard server missing: $server"}
  $fleetProcess=Start-Process -FilePath $node -ArgumentList @($server) -WorkingDirectory $root -RedirectStandardOutput (Join-Path $root 'server.log') -RedirectStandardError (Join-Path $root 'server-error.log') -WindowStyle Hidden -PassThru
  foreach($attempt in 1..14){
   Start-Sleep -Milliseconds 400
   $status=Read-Health $fleetHealth
   if($status.ok){break}
  }
  if(!$status.ok){throw 'Fleet dashboard failed to start. See server-error.log.'}
  Write-Host "Started Fleet dashboard with PID $($fleetProcess.Id)"
 }
 $hub=Read-Health 'http://127.0.0.1:4320/api/health'
 if($hub.ok -eq $true -and $hub.service -eq 'fleet-control-hub' -and $hub.nativeFleetOrigin -eq 'controller:8787'){
  $destination='http://127.0.0.1:4320/fleet/'
 }else{
  Write-Warning 'Updated Fleet Hub is unavailable; use the direct native controller temporarily.'
 }
}finally{
 if($ownsMutex){$launchMutex.ReleaseMutex()}
 $launchMutex.Dispose()
}
if($OpenBrowser){Start-Process $destination}
Write-Host "Dashboard: $destination"
