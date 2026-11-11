param([switch]$OpenBrowser)
$ErrorActionPreference='Stop'
$destination='http://127.0.0.1:4320/fleet/'
function Read-HubHealth {
 try {
  $hub=Invoke-RestMethod 'http://127.0.0.1:4320/api/health' -TimeoutSec 2 -ErrorAction Stop
  $native=Invoke-RestMethod 'http://127.0.0.1:4320/fleet/api/health' -TimeoutSec 2 -ErrorAction Stop
  return $hub.ok -eq $true -and $hub.service -eq 'fleet-control-hub' -and
   $hub.nativeFleetOrigin -eq 'embedded:in-process' -and $native.ok -eq $true -and $native.port -eq 4320
 } catch {return $false}
}
$mutex=[System.Threading.Mutex]::new($false,'Local\MJobsEmbeddedFleetDashboardLauncher')
$ownsMutex=$false
try {
 try {$ownsMutex=$mutex.WaitOne(10000)} catch [System.Threading.AbandonedMutexException] {$ownsMutex=$true}
 if(!$ownsMutex){throw 'Another Fleet Hub launch is in progress'}
 if(!(Read-HubHealth)){
  $task=Get-ScheduledTask -TaskName 'Fleet Control Hub' -ErrorAction Stop
  if(!$task.Settings.Enabled){throw 'Fleet Control Hub startup task is disabled'}
  if([string]$task.State -ne 'Running'){Start-ScheduledTask -InputObject $task -ErrorAction Stop}
  foreach($attempt in 1..20){Start-Sleep -Milliseconds 500;if(Read-HubHealth){break}}
 }
 if(!(Read-HubHealth)){throw 'Fleet Hub embedded MJobs controller is unavailable; no legacy listener was launched'}
} finally {
 if($ownsMutex){$mutex.ReleaseMutex()}
 $mutex.Dispose()
}
if($OpenBrowser){Start-Process $destination}
Write-Host "MJobs Fleet: $destination"
