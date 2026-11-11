'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const script=path.join(__dirname,'..','scripts','Open-Fleet-Workspace.ps1');
const source=fs.readFileSync(script,'utf8'),windows={skip:process.platform!=='win32'};
test('workspace launcher needs only Hub with embedded MJobs and BabyTracker',()=>{
  for(const name of ['BabyTracker - Fleet Control','Fleet Control Hub'])assert.ok(source.includes(name));
  assert.match(source,/embedded:in-process/);assert.match(source,/fleet\/api\/health/);
  assert.match(source,/local-canonical-matrices/);
  assert.match(source,/MultipleInstances -ne 'IgnoreNew'/);
  assert.match(source,/if \(!\$NoBrowser\) \{ Start-Process -FilePath \$hubUrl/);
  assert.doesNotMatch(source,/18729|18726|8787|MissionLauncher|missionLock|python\.exe|api\/run\/start|Register-ScheduledTask|Stop-Process|MJobs Fleet - Dashboards Standard/i);
  assert.match(source,/\$ReadyTimeoutSeconds = 20/);
});
function mockRun(config={}){
  const commands=[
    "$config=$env:FLEET_WORKSPACE_TEST_CONFIG | ConvertFrom-Json",
    "$global:events=[Collections.Generic.List[string]]::new()",
    "function Get-ScheduledTask {",
    " [CmdletBinding()]param($TaskName,$TaskPath)",
    " if($config.missingTask -eq $TaskName){throw 'TEST_TASK_MISSING'}",
    " $state=if($TaskName -eq 'Fleet Control Hub' -and $config.hubTaskStopped){'Ready'}else{'Running'}",
    " $policy=if($config.unsafePolicy){'StopExisting'}else{'IgnoreNew'}",
    " [pscustomobject]@{TaskName=$TaskName;State=$state;Settings=[pscustomobject]@{Enabled=$true;MultipleInstances=$policy}}",
    "}",
    "function Start-ScheduledTask {",
    " [CmdletBinding()]param($InputObject)",
    " $global:events.Add('task:'+$InputObject.TaskName)",
    " if($config.taskFailure){throw 'TEST_TASK_START_DENIED'}",
    "}",
    "function Invoke-WebRequest {",
    " [CmdletBinding()]param($Uri,$TimeoutSec,$MaximumRedirection,[switch]$UseBasicParsing)",
    " if($config.hubOffline){throw 'TEST_HUB_OFFLINE'}",
    " [pscustomobject]@{StatusCode=200;Content='<section id=\"fleets\"></section><section id=\"mission-control\"></section>'}",
    "}",
    "function Invoke-RestMethod {",
    " [CmdletBinding()]param($Uri,$TimeoutSec,$MaximumRedirection)",
    " if($Uri -match ':4319/') {return [pscustomobject]@{status='ok';spendingOnPageLoad=$false}}",
    " if($Uri -match ':4320/fleet/api/health') {return [pscustomobject]@{ok=(!$config.nativeOffline);port=4320}}",
    " if($Uri -match ':4320/api/health'){",
    "  if($config.oldHub){return [pscustomobject]@{ok=$true;service='fleet-control-hub';nativeFleetOrigin='controller:legacy'}}",
    "  return [pscustomobject]@{ok=$true;service='fleet-control-hub';nativeFleetOrigin='embedded:in-process';acceptanceSource='local-canonical-matrices'}",
    " }",
    " throw 'UNEXPECTED_PORT'",
    "}",
    "function Start-Process { [CmdletBinding()]param($FilePath) throw 'UNEXPECTED_BROWSER' }",
    "try{& $env:FLEET_WORKSPACE_TEST_SCRIPT -NoBrowser -ReadyTimeoutSeconds 2}",
    "catch{Write-Output ('FAILURE:'+$_.Exception.Message);exit 1}",
    "finally{Write-Output ('EVENTS:'+($global:events -join '|'))}"
  ].join('\n');
  return spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',commands],{
    encoding:'utf8',timeout:15000,env:{...process.env,FLEET_WORKSPACE_TEST_SCRIPT:script,FLEET_WORKSPACE_TEST_CONFIG:JSON.stringify(config)}});
}
test('workspace reuses healthy dashboards without any native legacy task',windows,()=>{
  const r=mockRun();assert.equal(r.status,0,r.stdout+r.stderr);
  assert.match(r.stdout,/"ready":true/);assert.match(r.stdout,/"agentWorkRequested":false/);
  assert.match(r.stdout,/EVENTS:\s*$/);assert.doesNotMatch(r.stdout,/UNEXPECTED_BROWSER|UNEXPECTED_PORT|task:/);
});
test('workspace fails closed when embedded controller is unavailable',windows,()=>{
  const r=mockRun({nativeOffline:true});assert.notEqual(r.status,0,r.stdout+r.stderr);
  assert.match(r.stdout,/not ready after 2 seconds/);assert.doesNotMatch(r.stdout,/"ready":true|task:/);
});
test('workspace rejects missing tasks and unsafe task policies',windows,()=>{
  for(const config of [{missingTask:'Fleet Control Hub'},{unsafePolicy:true}]){
    const r=mockRun(config);assert.notEqual(r.status,0,r.stdout+r.stderr);
    assert.match(r.stdout,/TEST_TASK_MISSING|IgnoreNew/);assert.doesNotMatch(r.stdout,/"ready":true|EVENTS:task:/);
  }
});
test('workspace rejects outdated Hub and failed task launches',windows,()=>{
  for(const config of [{hubOffline:true},{oldHub:true},{hubTaskStopped:true,hubOffline:true,taskFailure:true}]){
    const r=mockRun(config);assert.notEqual(r.status,0,r.stdout+r.stderr);
    assert.match(r.stdout,/not ready after 2 seconds|TEST_TASK_START_DENIED/);
    assert.doesNotMatch(r.stdout,/"ready":true/);
  }
});
