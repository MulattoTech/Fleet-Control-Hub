'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {RestoreFleet}=require('./restore-fleet');

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'scoped-restore-test-'));
  t.after(()=>{if(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep))fs.rmSync(root,{recursive:true,force:true});});
  const snapshot={at:new Date().toISOString(),kind:'AO-preserved-session-manifest-v1',sessions:[
    {id:'mjobs-luna-40',projectId:'mjobs-luna',kind:'orchestrator',harness:'codex',model:'gpt-test',mode:'chat',branch:'ao/mjobs',activity:'idle',isTerminated:false},
    {id:'mjobs-luna-5',projectId:'mjobs-luna',kind:'worker',harness:'codex',model:'gpt-test',mode:'tui',branch:'ao/mjobs-worker',activity:'idle',isTerminated:false},
    {id:'babytracker-1',projectId:'babytracker',kind:'orchestrator',harness:'codex',model:'gpt-test',mode:'chat',branch:'ao/baby',activity:'idle',isTerminated:false}
  ]};
  const snapshotPath=path.join(root,'restore-snapshot.json');
  fs.writeFileSync(snapshotPath,JSON.stringify(snapshot));
  const effects=[];
  const restore=new RestoreFleet({root,autoSchedule:false,locked:()=>false,dispatchOff:()=>effects.push('hold'),
    command:async args=>{effects.push(args);throw Error('No native command allowed in fixture');},
    getGlobalSessions:async()=>snapshot.sessions,runtimeInspector:async()=>new Map(),
    resourceReader:async()=>({ramGiB:20,diskGiB:100,cpuPercent:10}),watchdogInspector:async()=>true,
    audit:()=>{}});
  const scoped={...snapshot,sessions:snapshot.sessions.filter(s=>s.projectId==='mjobs-luna').map(s=>structuredClone(s))};
  return {root,snapshot,snapshotPath,scoped,restore,effects};
}

test('scoped restore rejects a noncanonical manifest before holding dispatch',t=>{
  const f=fixture(t);
  assert.throws(()=>f.restore.start({manifest:f.snapshot,projectScope:'mjobs-luna',startupRunId:'run-1'}),/no longer matches/);
  assert.deepEqual(f.effects,[]);
  assert.equal(f.restore.status().active,false);
});

test('scoped restore binds only MJobs targets to unchanged global snapshot',t=>{
  const f=fixture(t);
  const result=f.restore.start({manifest:f.scoped,projectScope:'mjobs-luna',startupRunId:'run-1'});
  assert.equal(result.total,2);
  assert.equal(f.restore.state.source.projectScope,'mjobs-luna');
  assert.deepEqual(f.restore.state.desiredIds,['mjobs-luna-40','mjobs-luna-5']);
  const scope=f.restore.restorationScope();
  assert.ok(scope);
  assert.deepEqual(scope.targets.map(s=>s.id).sort(),['mjobs-luna-40','mjobs-luna-5']);
  f.restore.pause();
  assert.deepEqual(f.effects,['hold']);
});

test('bounded restore accepts only the saved eligible MJobs primary with dispatch off',t=>{
  const f=fixture(t);
  f.snapshot.sessions.push({...f.snapshot.sessions[0],id:'mjobs-luna-1',activity:'exited'});
  fs.writeFileSync(f.snapshotPath,JSON.stringify(f.snapshot));
  const bounded={...f.snapshot,sessions:[structuredClone(f.snapshot.sessions[0])]};
  assert.throws(()=>f.restore.start({manifest:bounded,projectScope:'mjobs-luna',boundedPrimaryId:'mjobs-luna-40',startupRunId:'run-1',autoDispatchAfter:true}),/dispatch off/);
  assert.throws(()=>f.restore.start({manifest:f.scoped,projectScope:'mjobs-luna',boundedPrimaryId:'mjobs-luna-40',startupRunId:'run-1'}),/no longer matches/);
  assert.deepEqual(f.effects,[]);
  const result=f.restore.start({manifest:bounded,projectScope:'mjobs-luna',boundedPrimaryId:'mjobs-luna-40',startupRunId:'run-1'});
  assert.equal(result.total,1);
  assert.deepEqual(f.restore.state.desiredIds,['mjobs-luna-40']);
  assert.equal(f.restore.state.source.boundedPrimaryId,'mjobs-luna-40');
  assert.deepEqual(f.restore.restorationScope().targets.map(s=>s.id),['mjobs-luna-40']);
  f.restore.pause();
  assert.deepEqual(f.effects,['hold']);
});

test('bounded restore loses binding if BabyTracker snapshot changes',async t=>{
  const f=fixture(t),bounded={...f.snapshot,sessions:[structuredClone(f.snapshot.sessions[0])]};
  f.restore.start({manifest:bounded,projectScope:'mjobs-luna',boundedPrimaryId:'mjobs-luna-40',startupRunId:'run-1'});
  f.snapshot.sessions[2].branch='ao/baby-changed';
  fs.writeFileSync(f.snapshotPath,JSON.stringify(f.snapshot));
  assert.equal(f.restore.restorationScope(),null);
  assert.match((await f.restore.tick()).error,/lost its original manifest binding/);
  assert.deepEqual(f.effects,['hold']);
});

test('changing even a BabyTracker entry invalidates an active scoped restore before agent action',async t=>{
  const f=fixture(t);
  f.restore.start({manifest:f.scoped,projectScope:'mjobs-luna',startupRunId:'run-1'});
  f.snapshot.sessions[2].branch='ao/baby-changed';
  fs.writeFileSync(f.snapshotPath,JSON.stringify(f.snapshot));
  assert.equal(f.restore.restorationScope(),null);
  assert.match((await f.restore.tick()).error,/lost its original manifest binding/);
  assert.equal(f.restore.status().active,false);
  assert.deepEqual(f.effects,['hold']);
});

test('scoped restore inspects only MJobs and leaves live BabyTracker session untouched',async t=>{
  const f=fixture(t),projects=[],commands=[];
  f.restore.watchdogDisarmed=async()=>true;
  f.restore.getGlobalSessions=async()=>f.snapshot.sessions.map(s=>({...s,activity:{state:'idle'}}));
  f.restore.runtimeInspector=async ids=>{projects.push([...ids]);return new Map(f.snapshot.sessions.map(s=>[s.id,5]));};
  f.restore.command=async args=>{commands.push(args);throw Error('No native command expected for healthy fixture');};
  f.restore.start({manifest:f.scoped,projectScope:'mjobs-luna',startupRunId:'run-1'});
  const result=await f.restore.tick();
  assert.equal(result.complete,true);
  assert.ok(projects.length>0);
  assert.ok(projects.every(ids=>ids.length===1&&ids[0]==='mjobs-luna'));
  assert.deepEqual(commands,[]);
  assert.equal(f.snapshot.sessions[2].id,'babytracker-1');
});
