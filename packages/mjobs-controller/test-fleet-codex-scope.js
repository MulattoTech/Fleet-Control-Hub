'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {SCOPE_FILE,readScope,ensureScope,validateScope,sessionIdentity,sameIdentity,sweepFleetCodex}=require('./fleet-codex-scope');
const scope={version:1,projectIds:['mjobs-luna']};
function session(id='worker-1',patch={}){
 return {id,projectId:'mjobs-luna',harness:'codex',mode:'tui',createdAt:'2026-10-31T12:00:00.000Z',
  terminalGeneration:'runtime-1',isTerminated:false,activity:{state:'working'},...patch};
}
function fixture(rows=[session()]){
 const f={rows,attempts:{},stops:[],now:100000,latched:true,reads:0};
 f.options={scope,attempts:f.attempts,now:()=>f.now,isLatched:()=>f.latched,
  readSessions:async()=>{f.reads++;return structuredClone(f.rows);},
  stopSession:async s=>{f.stops.push(s.id);const current=f.rows.find(x=>x.id===s.id);current.nativeStopped=true;current.activity={state:'exited'};},
  verifyStopped:async s=>s.nativeStopped===true};
 f.sweep=patch=>sweepFleetCodex({...f.options,...patch});return f;
}
test('scope registration is exclusive, strict and never widens or repairs an existing file',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-codex-scope-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 assert.deepEqual(ensureScope(root,'mjobs-luna'),scope);const file=path.join(root,SCOPE_FILE),original=fs.readFileSync(file,'utf8');
 assert.deepEqual(ensureScope(root,'mjobs-luna'),scope);
 assert.throws(()=>ensureScope(root,'babytracker'),/not registered/);assert.equal(fs.readFileSync(file,'utf8'),original);
 fs.writeFileSync(file,'{broken');assert.throws(()=>ensureScope(root,'mjobs-luna'));assert.equal(fs.readFileSync(file,'utf8'),'{broken');
 assert.throws(()=>ensureScope(root,'../bad'));
 for(const value of [{version:2,projectIds:['mjobs-luna']},{version:1,projectIds:[]},{version:1,projectIds:['x','X']},
  {version:1,projectIds:['../bad']},{version:1,projectIds:['ok'],projects:['other']}])assert.throws(()=>validateScope(value));
 fs.writeFileSync(file,JSON.stringify(scope));assert.deepEqual(readScope(root),scope);
});
test('session identity pins exact native generation and validates ISO creation/boolean termination',()=>{
 const identity=sessionIdentity(session());assert(identity);assert(sameIdentity(identity,sessionIdentity(session())));
 assert.equal(sameIdentity({},{}),false);assert.equal(sameIdentity(null,identity),false);
 for(const patch of [{createdAt:'not-a-date'},{createdAt:'2026-02-30T00:00:00Z'},{isTerminated:0},{mode:'shell'},{harness:'agy'},
  {id:'../worker'},{projectId:''},{terminalGeneration:3}])assert.equal(sessionIdentity(session('worker-1',patch)),null);
 assert(!sameIdentity(identity,sessionIdentity(session('worker-1',{terminalGeneration:'runtime-2'}))));
 assert(sameIdentity(identity,sessionIdentity(session('worker-1',{isTerminated:true}))),'Archiving is not session-ID reuse');
});
test('only registered Codex AO sessions are stopped; outside projects and other providers survive',async()=>{
 const f=fixture([session(),session('manual-like',{projectId:'personal'}),session('other-fleet',{projectId:'babytracker'}),
  session('gemini',{harness:'agy'}),session('archived',{isTerminated:true})]);
 const out=await f.sweep();assert.deepEqual(f.stops,['worker-1']);assert.equal(out.phase,'holding_zero');
 assert.equal(out.remainingTotal,0);assert.equal(out.scope,'fleet-owned');assert.equal(out.manualSessionsPreserved,true);
 assert.equal(out.orphanProcessesInspected,false);assert.deepEqual(Object.keys(out.remaining),['codex']);
 assert.equal(f.rows.find(x=>x.id==='manual-like').nativeStopped,undefined);
});
test('an empty current AO roster claims only registered-session zero, never OS process absence',async()=>{
 const f=fixture([]),out=await f.sweep();assert.equal(out.phase,'holding_zero');assert.equal(out.orphanProcessesInspected,false);assert.deepEqual(f.stops,[]);
});
test('duplicate native IDs and malformed owned identities fail closed without mutation',async()=>{
 for(const rows of [[session(),session()],[session(),session('WORKER-1')],[session('worker-1',{createdAt:'bad'})]]){
  const f=fixture(rows),out=await f.sweep();assert.equal(out.phase,'partial_stop');assert.equal(out.remainingTotal,null);assert.deepEqual(f.stops,[]);
 }
});
test('AO unavailable and unavailable final runtime proof never report zero',async()=>{
 const offline=fixture(),a=await offline.sweep({readSessions:async()=>{throw Error('offline');}});
 assert.equal(a.remainingTotal,null);assert.deepEqual(offline.stops,[]);
 const unavailable=fixture(),b=await unavailable.sweep({verifyStopped:async()=>{throw Error('no native proof');}});
 assert.equal(b.phase,'partial_stop');assert.equal(b.remainingTotal,null);
});
test('changed identity before native stop is never targeted',async()=>{
 for(const patch of [{createdAt:'2026-10-31T13:00:00Z'},{terminalGeneration:'new-generation'},{projectId:'personal'},
  {mode:'chat'},{harness:'agy'}]){
  const f=fixture();let reads=0;
  const out=await f.sweep({readSessions:async()=>{if(++reads===2)Object.assign(f.rows[0],patch);return structuredClone(f.rows);}});
  assert.deepEqual(f.stops,[]);assert.equal(out.remainingTotal,null);
 }
});
test('changed or disappeared identity after stop remains unverified and is not replayed',async()=>{
 for(const disappear of [false,true]){
  const f=fixture();const out=await f.sweep({stopSession:async s=>{f.stops.push(s.id);if(disappear)f.rows=[];else f.rows[0].terminalGeneration='new';}});
  assert.deepEqual(f.stops,['worker-1']);assert.equal(out.remainingTotal,null);assert.equal(out.submissions,1);
 }
});
test('native stop submission is not proof; active session remains partial',async()=>{
 const f=fixture(),out=await f.sweep({stopSession:async s=>f.stops.push(s.id)});
 assert.equal(out.phase,'partial_stop');assert.equal(out.remainingTotal,1);assert.deepEqual(f.stops,['worker-1']);
});
test('a submitted stop timeout is observed once, not replayed, and real stop proof may resolve it',async()=>{
 const f=fixture(),out=await f.sweep({stopSession:async s=>{f.stops.push(s.id);f.rows[0].nativeStopped=true;throw Error('uncertain timeout');}});
 assert.deepEqual(f.stops,['worker-1']);assert.equal(out.remainingTotal,0);assert.equal(out.phase,'holding_zero');assert.equal(out.errorCount,1);
});
test('dry run mutates neither native sessions nor attempt ledger',async()=>{
 const f=fixture(),out=await f.sweep({dryRun:true});assert.deepEqual(f.stops,[]);assert.deepEqual(f.attempts,{});
 assert.equal(out.remainingTotal,1);assert.equal(out.results[0].status,'would_stop');
});
test('latch release before submission aborts action and cannot report verified zero',async()=>{
 const f=fixture();let checks=0;
 const out=await f.sweep({isLatched:()=>++checks<3});assert.deepEqual(f.stops,[]);assert.equal(out.phase,'partial_stop');assert.equal(out.remainingTotal,null);
 const off=fixture([]),empty=await off.sweep({isLatched:()=>false});assert.equal(empty.remainingTotal,null);
});
test('attempt reservation exists before native call; retries are throttled and bounded per generation',async()=>{
 const f=fixture();f.options.stopSession=async s=>{assert.equal(f.attempts[s.id].count,f.stops.length+1);f.stops.push(s.id);};
 await f.sweep();assert.equal(f.attempts['worker-1'].count,1);assert.equal(f.attempts['worker-1'].lastAttempt,100000);
 await f.sweep();assert.equal(f.stops.length,1);
 f.now+=30000;await f.sweep();f.now+=30000;await f.sweep();f.now+=30000;await f.sweep();assert.equal(f.stops.length,3);
 f.rows[0].terminalGeneration='runtime-2';f.options.stopSession=async s=>{assert.equal(f.attempts[s.id].count,1);f.stops.push(s.id);};
 await f.sweep();assert.equal(f.stops.length,4);
});
test('at most four submissions and unattempted sessions are not starved by retries',async()=>{
 const f=fixture(Array.from({length:7},(_,i)=>session('worker-'+i)));
 f.options.stopSession=async s=>f.stops.push(s.id);
 const first=await f.sweep();assert.equal(first.submissions,4);assert.equal(first.remainingTotal,7);
 f.now+=30000;const second=await f.sweep();assert.deepEqual(f.stops.slice(4,7),['worker-4','worker-5','worker-6']);
 assert.equal(second.submissions,4);assert.equal(second.remainingTotal,7);
});
test('new targets discovered after a stop cannot be silently counted as zero',async()=>{
 const f=fixture();f.options.stopSession=async s=>{f.stops.push(s.id);f.rows[0].nativeStopped=true;f.rows.push(session('late-worker'));};
 const out=await f.sweep();assert.equal(out.phase,'partial_stop');assert.equal(out.remainingTotal,1);assert.deepEqual(f.stops,['worker-1']);
});
test('archived sessions are excluded without making a global orphan claim',async()=>{
 const f=fixture();const out=await f.sweep({stopSession:async()=>{f.rows[0].isTerminated=true;}});
 assert.equal(out.remainingTotal,0);assert.equal(out.orphanProcessesInspected,false);assert.match(out.notes,/orphan OS process absence is not claimed/);
});
test('Map attempt ledger is supported and malformed matching ledger is not reset',async()=>{
 const f=fixture(),attempts=new Map();f.options.stopSession=async()=>{};
 await f.sweep({attempts});assert.equal(attempts.get('worker-1').count,1);
 attempts.get('worker-1').count=-1;
 const out=await f.sweep({attempts});assert.equal(out.remainingTotal,null);assert.equal(out.submissions,0);
});
test('elapsed deadline aborts a pending proof, starts no later native work and reports unknown',async()=>{
 const f=fixture();let receivedSignal;
 const out=await f.sweep({maxSweepMs:15,verifyStopped:async(_session,context)=>{
  receivedSignal=context.signal;assert(context.remainingMs()>0);
  await new Promise(resolve=>context.signal.addEventListener('abort',resolve,{once:true}));return true;
 }});
 assert(receivedSignal.aborted);assert.equal(out.budgetExhausted,true);assert.equal(out.phase,'partial_stop');
 assert.equal(out.remainingTotal,null);assert.deepEqual(f.stops,[]);
});
test('native proof call budget leaves unprocessed rows unknown instead of zero',async()=>{
 const f=fixture([session('first',{nativeStopped:true}),session('second',{nativeStopped:true})]);
 const out=await f.sweep({maxVerificationCalls:1});assert.equal(out.verificationCalls,1);
 assert.equal(out.verificationExhausted,true);assert.equal(out.remainingTotal,null);assert.equal(out.phase,'partial_stop');
 assert.deepEqual(f.stops,[]);
});
test('latch is checked before every final proof, not only before the stop loop',async()=>{
 const f=fixture([session('first',{nativeStopped:true}),session('second',{nativeStopped:true})]);let calls=0;
 const out=await f.sweep({verifyStopped:async()=>{calls++;if(calls===3)f.latched=false;return true;}});
 assert.equal(calls,3,'The second final proof must not start after disarm');
 assert.equal(out.remainingTotal,null);assert.equal(out.phase,'partial_stop');assert.deepEqual(f.stops,[]);
});
test('deadline context reaches a native stop and its uncertain outcome is not replayed',async()=>{
 const f=fixture();let signal;
 const out=await f.sweep({maxSweepMs:15,stopSession:async(_session,context)=>{
  f.stops.push('worker-1');signal=context.signal;
  await new Promise(resolve=>context.signal.addEventListener('abort',resolve,{once:true}));
 }});
 assert(signal.aborted);assert.deepEqual(f.stops,['worker-1']);assert.equal(f.attempts['worker-1'].count,1);
 assert.equal(out.submissions,1);assert.equal(out.remainingTotal,null);
});
test('large fleets cannot start hundreds of proof calls in one sweep',async()=>{
 const f=fixture(Array.from({length:250},(_,i)=>session('worker-'+i,{nativeStopped:true})));
 const out=await f.sweep();assert.equal(out.verificationCalls,64);assert.equal(out.verificationExhausted,true);
 assert.equal(out.remainingTotal,null);assert.deepEqual(f.stops,[]);
});
test('persisted fair inspections reach live sessions beyond a stopped prefix and revisit their retries',async()=>{
 const f=fixture([...Array.from({length:80},(_,i)=>session('a-stopped-'+String(i).padStart(3,'0'),{nativeStopped:true})),
  session('z-live')]);
 f.options.stopSession=async s=>f.stops.push(s.id);
 const first=await f.sweep();assert.equal(first.verificationCalls,64);assert.deepEqual(f.stops,[]);
 const inspected=f.attempts['a-stopped-000'];
 assert.equal(inspected.count,0,'Read-only inspection is not a native stop attempt');
 assert.equal(inspected.lastAttempt,0);assert.equal(inspected.inspectedAt,f.now);
 // The watcher is a new Node process each sweep; fairness must survive JSON
 // persistence, not rely on an in-memory cursor or mutation of AO metadata.
 for(let sweep=0;sweep<5;sweep++){
  f.attempts=JSON.parse(JSON.stringify(f.attempts));f.options.attempts=f.attempts;f.now+=30000;
  const out=await f.sweep();assert(out.verificationCalls<=64);assert.equal(out.remainingTotal,null);
  if(sweep===0)assert.deepEqual(f.stops,['z-live'],'The second sweep must reach the previously hidden live target');
 }
 assert.deepEqual(f.stops,['z-live','z-live','z-live'],'Already-stopped count-zero targets must not starve count-one/two retries');
 assert.equal(f.attempts['z-live'].count,3);
 assert.equal(f.attempts['a-stopped-000'].count,0);assert.equal(f.attempts['a-stopped-000'].lastAttempt,0);
});
test('invalid persisted inspection progress fails closed instead of resetting fairness',async()=>{
 const f=fixture([session('stopped',{nativeStopped:true})]);await f.sweep();
 f.attempts.stopped.inspectedAt=-1;
 const out=await f.sweep();assert.equal(out.remainingTotal,null);assert.equal(out.submissions,0);assert.equal(out.verificationCalls,0);
});
