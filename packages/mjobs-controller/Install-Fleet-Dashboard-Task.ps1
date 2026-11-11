param(
 [string]$Root='C:\Tools\AO-Fleet-Control',
 [string]$TaskName='Fleet Control Hub',
 [switch]$RunNow
)
$ErrorActionPreference='Stop'
if($TaskName -ne 'Fleet Control Hub'){throw 'The separate MJobs dashboard task is retired. Use the Fleet Control Hub task.'}
$task=Get-ScheduledTask -TaskName 'Fleet Control Hub' -ErrorAction Stop
if(!$task.Settings.Enabled){throw 'Fleet Control Hub startup task is disabled'}
if($RunNow){Start-ScheduledTask -InputObject $task -ErrorAction Stop}
[pscustomobject]@{taskName='Fleet Control Hub';reused=$true;separateMJobsTaskRegistered=$false;startsAgents=$false;started=[bool]$RunNow} | ConvertTo-Json -Compress
