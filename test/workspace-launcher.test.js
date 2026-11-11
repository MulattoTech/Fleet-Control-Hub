'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const script=path.join(__dirname,'..','scripts','Open-Fleet-Workspace.ps1');
const source=fs.readFileSync(script,'utf8'),windows={skip:process.platform!=='win32'};
test('workspace launcher checks only Hub and native controllers',()=>{
  for(const name of ['BabyTracker - Fleet Control','MJobs Fleet - Dashboards Standard','Fleet Control Hub'])assert.ok(source.includes(name));
  assert.match(source,/controller:8787/);assert.match(source,/local-canonical-matrices/);
  assert.match(source,/MultipleInstances -ne 'IgnoreNew'/);
  assert.match(source,/if \(!\$NoBrowser\) \{ Start-Process -FilePath \$hubUrl/);
  assert.doesNotMatch(source,/18729|18726|MissionLauncher|missionLock|python\.exe|api\/run\/start|Register-ScheduledTask|Stop-Process/i);
  assert.match(source,/\$ReadyTimeoutSeconds = 20/);
});
function mockRun(config={}){
  const commands=[
    "$config=$env:FLEET_WORKSPACE_TEST_CONFIG | ConvertFrom-Json",
    "$global:events=[Collections.Generic.List[string]]::new()",
    "$global:mjobsReady=!$config.mjobsOffline",
    "function Get-ScheduledTask {",
    " [CmdletBinding()]param($TaskName,$TaskPath)",
    " if($config.missingTask -eq $TaskName){throw 'TEST_TASK_MISSING'}",
    " $state=if($TaskName -eq 'MJobs Fleet - Dashboards Standard'){'Ready'}else{'Running'}",
    " $policy=if($config.unsafePolicy){'StopExisting'}else{'IgnoreNew'}",
    " [pscustomobject]@{TaskName=$TaskName;State=$state;Settings=[pscustomobject]@{Enabled=$true;MultipleInstances=$policy}}",
    "}",
    "function Start-ScheduledTask {",
    " [CmdletBinding()]param($InputObject)",
    " $global:events.Add('task:'+$InputObject.TaskName)",
    " if($config.taskFailure){throw 'TEST_TASK_START_DENIED'}",
    " $global:mjobsReady=$true",
    "}",
    "function Invoke-WebRequest {",
    " [CmdletBinding()]param($Uri,$TimeoutSec,$MaximumRedirection,[switch]$UseBasicParsing)",
    " if($config.hubOffline){throw 'TEST_HUB_OFFLINE'}",
    " [pscustomobject]@{StatusCode=200;Content='<section id=\"fleets\"></section><section id=\"mission-control\"></section>'}",
    "}",
    "function Invoke-RestMethod {",
    " [CmdletBinding()]param($Uri,$TimeoutSec,$MaximumRedirection)",
    " if($Uri -match ':4319/') {return [pscustomobject]@{status='ok';spendingOnPageLoad=$false}}",
    " if($Uri -match ':8787/') {return [pscustomobject]@{ok=$global:mjobsReady}}",
    " if($Uri -match ':4320/'){",
    "  if($config.oldHub){return [pscustomobject]@{ok=$true;service='fleet-control-hub';nativeFleetOrigin='mission:18729'}}",
    "  return [pscustomobject]@{ok=$true;service='fleet-control-hub';nativeFleetOrigin='controller:8787';acceptanceSource='local-canonical-matrices'}",
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
test('workspace reuses healthy dashboards and never opens browser',windows,()=>{
  const r=mockRun();assert.equal(r.status,0,r.stdout+r.stderr);
  assert.match(r.stdout,/"ready":true/);assert.match(r.stdout,/"agentWorkRequested":false/);
  assert.match(r.stdout,/EVENTS:\s*$/);assert.doesNotMatch(r.stdout,/UNEXPECTED_BROWSER|UNEXPECTED_PORT/);
});
test('workspace requests only a missing native dashboard',windows,()=>{
  const r=mockRun({mjobsOffline:true});assert.equal(r.status,0,r.stdout+r.stderr);
  assert.match(r.stdout,/task:MJobs Fleet - Dashboards Standard/);
  assert.doesNotMatch(r.stdout,/mission:|task:BabyTracker|task:Fleet Control Hub/);
});
test('workspace rejects missing tasks and unsafe task policies',windows,()=>{
  for(const config of [{missingTask:'Fleet Control Hub'},{unsafePolicy:true}]){
    const r=mockRun(config);assert.notEqual(r.status,0,r.stdout+r.stderr);
    assert.match(r.stdout,/TEST_TASK_MISSING|IgnoreNew/);assert.doesNotMatch(r.stdout,/"ready":true|EVENTS:task:/);
  }
});
test('workspace rejects outdated Hub or failed tasks',windows,()=>{
  for(const config of [{hubOffline:true},{oldHub:true},{mjobsOffline:true,taskFailure:true}]){
    const r=mockRun(config);assert.notEqual(r.status,0,r.stdout+r.stderr);
    assert.match(r.stdout,/not ready after 2 seconds|TEST_TASK_START_DENIED/);
    assert.doesNotMatch(r.stdout,/"ready":true/);
  }
});
