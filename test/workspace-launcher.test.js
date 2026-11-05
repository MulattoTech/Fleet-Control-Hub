'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync,spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..'),script=path.join(root,'scripts','Open-Fleet-Workspace.ps1');
const source=fs.readFileSync(script,'utf8'),windows={skip:process.platform!=='win32'};

test('landing card leads to protected Fleet Overview and keeps telemetry plus canonical source secondary',()=>{
  const card=fs.readFileSync(path.join(root,'packages/mjobs-controller/remote/hub-card.html'),'utf8');
  assert.equal((card.match(/id="fleet-mission-control-card"/g)||[]).length,1);
  assert.match(card,/class="link-primary" href="https:\/\/fleet\.m-techlabs\.com\/">Open Fleet Overview/);
  for(const href of ['/mission-control/','/mission-control/analytics/','/mission-control/grafana/','https://github.com/MulattoTech/Fleet-Control-Hub'])
    assert.ok(card.includes('class="link-secondary" href="'+href+'"'));
  assert.doesNotMatch(card,/MJobs\/tree\/main\/tools\/fleet_control|127\.0\.0\.1/);
  assert.match(card,/Owner protected/);
});

test('workspace launcher has only scoped dashboard startup and bounded read-only readiness',()=>{
  assert.match(source,/\[switch\]\$NoBrowser/);
  for(const name of ['BabyTracker - Fleet Control','MJobs Fleet - Dashboards Standard','Fleet Control Hub'])assert.ok(source.includes(name));
  assert.match(source,/\$ReadyTimeoutSeconds = 20/);assert.match(source,/\$MissionTimeoutSeconds = 80/);
  assert.match(source,/-Port '\s*\+ \$MissionPort \+ ' -NoBrowser'/);
  assert.match(source,/MultipleInstances -ne 'IgnoreNew'/);
  assert.match(source,/State -ne 'Running'\) \{ Start-ScheduledTask/);
  assert.match(source,/FleetControlHub\.MissionDashboard\./);assert.match(source,/\$missionLock\.WaitOne\(0\)/);
  assert.match(source,/if \(\$ownsMissionLock\) \{ \$missionLock\.ReleaseMutex\(\) \}/);
  assert.equal((source.match(/-MaximumRedirection 0/g)||[]).length,2);
  assert.doesNotMatch(source,/ExecutionPolicy\s+(?:Bypass|Unrestricted)|Set-ExecutionPolicy|Invoke-Expression|Register-ScheduledTask|Stop-Process|api\/(?:action|control|start|run\/start)/i);
  assert.doesNotMatch(source,/Start-Sleep\s+-Seconds|WaitForExit\((?:[2-9]\d{3}|\d{5,})\)/);
  assert.match(source,/if \(!\$NoBrowser\) \{ Start-Process -FilePath \$hubUrl/);
});

function mockRun(t,config={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-launcher-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const mission=path.join(dir,'mission.ps1');fs.writeFileSync(mission,'# Never executed: Start-Process is mocked.\n');
  const commands=String.raw`
    $config = $env:FLEET_WORKSPACE_TEST_CONFIG | ConvertFrom-Json
    $global:events = [Collections.Generic.List[string]]::new()
    $global:missionReady = !$config.missionOffline
    $global:mjobsReady = !$config.mjobsOffline
    $testMissionPort = if ($config.missionPort) { [int]$config.missionPort } else { 18726 }
    function Get-ScheduledTask {
      [CmdletBinding()]param($TaskName,$TaskPath)
      if ($config.missingTask -eq $TaskName) { throw 'TEST_TASK_MISSING' }
      $state = if ($TaskName -eq 'MJobs Fleet - Dashboards Standard') { 'Ready' } else { 'Running' }
      $policy = if ($config.unsafePolicy) { 'StopExisting' } else { 'IgnoreNew' }
      [pscustomobject]@{TaskName=$TaskName;State=$state;Settings=[pscustomobject]@{Enabled=$true;MultipleInstances=$policy}}
    }
    function Start-ScheduledTask {
      [CmdletBinding()]param($InputObject)
      $global:events.Add('task:'+ $InputObject.TaskName)
      if ($config.taskFailure) { throw 'TEST_TASK_START_DENIED' }
      $global:mjobsReady = $true
    }
    function Invoke-WebRequest {
      [CmdletBinding()]param($Uri,$TimeoutSec,$MaximumRedirection,[switch]$UseBasicParsing)
      if ($config.hubOffline) { throw 'TEST_HUB_OFFLINE' }
      [pscustomobject]@{StatusCode=200;Content='<section id="fleets"></section><section id="mission-control"></section>'}
    }
    function Invoke-RestMethod {
      [CmdletBinding()]param($Uri,$TimeoutSec,$MaximumRedirection)
      if ($Uri -match ':4319/') { return [pscustomobject]@{status='ok';spendingOnPageLoad=$false} }
      if ($Uri -match ':8787/') { return [pscustomobject]@{ok=$global:mjobsReady} }
      if ($Uri -match (':' + $testMissionPort + '/') -and !$global:missionReady) { throw 'TEST_MISSION_OFFLINE' }
      [pscustomobject]@{service='mjobs-mission-control';version=8;fleet_control_path='/fleet/';console_output_binding='CONOUT$';prompt_preview=$true;approval_required=$true;history_available=$true;visible_terminal=$true;subagent_controls=$true;prompt_via_stdin=$true;python_environment_preflight=$true;accurate_partial_state=$true;crlf_summary_fix=$true}
    }
    function Start-Process {
      [CmdletBinding()]param($FilePath,$ArgumentList,$WorkingDirectory,$WindowStyle,[switch]$PassThru)
      if ($FilePath -match '^http') { throw 'UNEXPECTED_BROWSER' }
      $global:events.Add('mission:'+ $ArgumentList)
      $global:missionReady = !$config.missionHealthFailure
      $code = if ($config.missionFailure) { 1 } else { 0 }
      $process = [pscustomobject]@{Id=12345;ExitCode=$code}
      $process | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {param($milliseconds) return !$config.missionTimeout}
      $process | Add-Member -MemberType ScriptMethod -Name Kill -Value {$global:events.Add('helper-killed')}
      $process | Add-Member -MemberType ScriptMethod -Name Dispose -Value {}
      return $process
    }
    try { & $env:FLEET_WORKSPACE_TEST_SCRIPT -NoBrowser -MissionLauncherPath $env:FLEET_WORKSPACE_TEST_MISSION -MissionPort $testMissionPort -ReadyTimeoutSeconds 2 -MissionTimeoutSeconds 2 }
    catch { Write-Output ('FAILURE:'+ $_.Exception.Message); exit 1 }
    finally { Write-Output ('EVENTS:'+ ($global:events -join '|')) }
  `;
  return spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',commands],{encoding:'utf8',timeout:15000,
    env:{...process.env,FLEET_WORKSPACE_TEST_SCRIPT:script,FLEET_WORKSPACE_TEST_MISSION:mission,FLEET_WORKSPACE_TEST_CONFIG:JSON.stringify(config)}});
}

test('Windows workspace click reuses running tasks and healthy detached dashboards without opening a browser',windows,t=>{
  const result=mockRun(t);assert.equal(result.status,0,result.stdout+result.stderr);
  assert.match(result.stdout,/"ready":true/);assert.match(result.stdout,/"agentWorkRequested":false/);assert.match(result.stdout,/"browserOpened":false/);
  assert.match(result.stdout,/EVENTS:\s*$/);assert.doesNotMatch(result.stdout,/UNEXPECTED_BROWSER/);
});
test('Windows workspace startup only requests a missing dashboard and passes NoBrowser to Mission launcher',windows,t=>{
  const result=mockRun(t,{mjobsOffline:true,missionOffline:true});assert.equal(result.status,0,result.stdout+result.stderr);
  assert.match(result.stdout,/task:MJobs Fleet - Dashboards Standard/);assert.doesNotMatch(result.stdout,/task:BabyTracker|task:Fleet Control Hub/);
  assert.match(result.stdout,/mission:.*-Port 18726 -NoBrowser/);
});
test('Windows workspace rejects missing or unsafe scheduled tasks before requesting startup',windows,t=>{
  for(const config of [{missingTask:'Fleet Control Hub'},{unsafePolicy:true}]){
    const result=mockRun(t,config);assert.notEqual(result.status,0,result.stdout+result.stderr);
    assert.match(result.stdout,/TEST_TASK_MISSING|IgnoreNew/);assert.doesNotMatch(result.stdout,/"ready":true|EVENTS:task:|EVENTS:mission:/);
  }
});
test('Windows workspace cannot claim readiness after a task or Mission launcher failure',windows,t=>{
  for(const config of [{mjobsOffline:true,taskFailure:true},{missionOffline:true,missionFailure:true},{missionOffline:true,missionHealthFailure:true}]){
    const result=mockRun(t,config);assert.notEqual(result.status,0,result.stdout+result.stderr);
    assert.match(result.stdout,/TEST_TASK_START_DENIED|launcher exited with code 1|health at port 18726 is not verified/);
    assert.doesNotMatch(result.stdout,/"ready":true|UNEXPECTED_BROWSER/);
  }
});
test('Windows workspace readiness and Mission helper waits fail bounded without restarting running tasks',windows,t=>{
  const hub=mockRun(t,{hubOffline:true});assert.notEqual(hub.status,0,hub.stdout+hub.stderr);
  assert.match(hub.stdout,/not ready after 2 seconds/);assert.doesNotMatch(hub.stdout,/EVENTS:task:|"ready":true/);
  const mission=mockRun(t,{missionOffline:true,missionTimeout:true});assert.notEqual(mission.status,0,mission.stdout+mission.stderr);
  assert.match(mission.stdout,/Mission Control startup timed out/);assert.match(mission.stdout,/helper-killed/);
  assert.doesNotMatch(mission.stdout,/"ready":true/);
});

test('Windows concurrent workspace invocation cannot launch a second Mission helper',windows,async t=>{
  const missionPort=48000+Math.floor(Math.random()*1000),name='Local\\FleetControlHub.MissionDashboard.'+missionPort;
  const commands="$fleetTestLock=[Threading.Mutex]::new($false,'"+name+"');$held=$false;try{$held=$fleetTestLock.WaitOne(0);if(!$held){throw 'LOCK_UNAVAILABLE'};Write-Output 'LOCK_HELD';[Console]::Out.Flush();[void][Console]::ReadLine()}finally{if($held){$fleetTestLock.ReleaseMutex()};$fleetTestLock.Dispose()}";
  const holder=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',commands],{stdio:['pipe','pipe','pipe']});
  t.after(()=>{holder.stdin.end();if(holder.exitCode===null)holder.kill();});
  await new Promise((resolve,reject)=>{
    let output='';const timeout=setTimeout(()=>reject(Error('Mutex fixture did not become ready')),6000);
    holder.stdout.on('data',data=>{output+=data;if(output.includes('LOCK_HELD')){clearTimeout(timeout);resolve();}});
    holder.once('error',error=>{clearTimeout(timeout);reject(error);});
    holder.once('exit',code=>{clearTimeout(timeout);if(!output.includes('LOCK_HELD'))reject(Error('Mutex fixture exited: '+code));});
  });
  const result=mockRun(t,{missionPort,missionOffline:true});
  assert.notEqual(result.status,0,result.stdout+result.stderr);
  assert.match(result.stdout,/Another Fleet workspace launch/);
  assert.doesNotMatch(result.stdout,/EVENTS:mission:|"ready":true/);
});
