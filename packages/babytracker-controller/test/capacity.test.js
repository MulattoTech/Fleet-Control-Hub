'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {capacitySnapshot}=require('../capacity');
const {FleetController}=require('../controller');
const {PROJECT,SOURCE_REPO,ISSUE_REPO}=require('../config');
const now=Date.parse('2026-10-28T04:37:00Z');
function agent(id,extra={}){return {id,projectId:PROJECT,harness:'codex',kind:'worker',displayName:id,activity:{state:'idle'},isTerminated:false,...extra};}
function snapshot(sessions,entries={},limit=2){return capacitySnapshot({sessions,entries,limit,now,cooldownMs:120000});}
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-capacity-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const state={sessions:[agent('babytracker-1',{kind:'orchestrator',activity:{state:'active'}}),agent('babytracker-4',{activity:{state:'active'}}),agent('babytracker-3'),agent('babytracker-5',{harness:'agy'})],commands:[],offline:false};
 const config={projectId:PROJECT,sourceRepository:SOURCE_REPO,issueRepository:ISSUE_REPO,stateDir:root,runtimeVerified:true};
 const deps={adapter:{sessions:async()=>{if(state.offline)throw Error('AO offline');return structuredClone(state.sessions);},command:async(...args)=>{state.commands.push(args);return {submitted:true};}},quota:()=>({fresh:true,remainingPercent:13,sharedEmergencyGuard:{thresholdPercent:7,armed:true}}),now:()=>now,resources:()=>({freeMemoryGiB:18,totalMemoryGiB:64})};
 const controller=new FleetController(config,deps);controller.limits({minimumRemainingPercent:7});
 return {controller,state,config,deps};
}
test('actual Codex turn owners consume both slots, not staged Gemini preferences',()=>{
 const sessions=[agent('babytracker-1',{kind:'orchestrator',activity:{state:'active'}}),agent('babytracker-4',{activity:{state:'active'}}),agent('babytracker-5',{harness:'agy'})];
 const c=snapshot(sessions);assert.equal(c.used,2);assert.equal(c.full,true);assert.equal(c.executing,2);assert.equal(c.pending,0);assert.equal(c.unresolved,0);assert.deepEqual(c.byProvider,{codex:2});assert.match(c.reason,/babytracker-1.*codex.*babytracker-4.*codex/);
});
test('one shared project cap includes orchestrators and Gemini, excludes terminated and MJobs sessions',()=>{
 const c=snapshot([agent('primary',{kind:'orchestrator',activity:{state:'active'}}),agent('google-worker',{harness:'agy',activity:{state:'working'}}),agent('mjobs',{projectId:'mjobs-luna',activity:{state:'active'}}),agent('dead',{isTerminated:true,activity:{state:'active'}})]);
 assert.equal(c.used,2);assert.deepEqual(c.byProvider,{codex:1,agy:1});assert.equal(c.slots[0].role,'orchestrator');
});
test('active and recent ledger state never double-counts the same session',()=>{
 const c=snapshot([agent('worker',{activity:{state:'active'}}),agent('worker',{activity:{state:'active'}})],{worker:{at:now,status:'submitted'}});
 assert.equal(c.used,1);assert.equal(c.executing,1);assert.equal(c.pending,0);
});
test('old submitted cooldowns expire, but uncertain deliveries never time out automatically',()=>{
 const entries={settling:{at:now-10000,status:'submitted'},old:{at:now-900000,status:'submitted'},unknown:{at:now-900000,status:'uncertain'},reserved:{at:now-900000,status:'reserved'}};
 const original=structuredClone(entries),c=snapshot(Object.keys(entries).map(id=>agent(id)),entries,4);
 assert.equal(c.used,3);assert.equal(c.pending,1);assert.equal(c.unresolved,2);assert.equal(c.slots.find(s=>s.id==='settling').holdSeconds,110);assert.deepEqual(entries,original);
});
test('unreachable runtime does not fabricate empty capacity or available slots',()=>{
 const c=capacitySnapshot({sessions:[],limit:2,online:false,now});assert.equal(c.used,null);assert.equal(c.free,null);assert.equal(c.full,null);assert.equal(c.online,false);
});
test('full capacity changes dashboard eligibility and names blockers in the backend refusal',async t=>{
 const f=fixture(t);await f.controller.start();f.controller.state.plans['babytracker-1']={status:'staged',harness:'agy',model:'gemini-3.8-flash-high'};
 const s=await f.controller.snapshot();assert.equal(s.capacity.used,2);assert.equal(s.summary.available,0);assert.equal(s.sessions.find(s=>s.id==='babytracker-3').label,'Waiting for slot');assert.equal(s.sessions.find(s=>s.id==='babytracker-3').canDispatch,false);assert.equal(s.sessions.find(s=>s.id==='babytracker-1').harness,'codex');
 await assert.rejects(f.controller.dispatch('babytracker-3'),/Concurrency full: 2\/2.*babytracker-1.*babytracker-4/);assert.equal(f.state.commands.length,0);
 const all=await f.controller.allHands();assert.equal(all.results.length,0);assert.match(all.note,/Concurrency full/);assert.equal(f.state.commands.length,0);
});
test('raising concurrency live preserves run budget, pause state, quotas and model choices; it sends nothing',async t=>{
 const f=fixture(t);await f.controller.start();f.controller.state.run.dispatches=3;f.controller.state.plans['babytracker-1']={status:'staged',harness:'agy',model:'gemini-3.8-flash-high'};
 const before=structuredClone(f.controller.state),result=await f.controller.updateConcurrency(4),s=await f.controller.snapshot();
 assert.equal(result.capacity.limit,4);assert.equal(s.capacity.free,2);assert.equal(s.mode,'running');assert.equal(s.sessions.find(s=>s.id==='babytracker-3').canDispatch,true);assert.deepEqual(s.run,before.run);assert.deepEqual(s.plans,before.plans);assert.equal(s.limits.minimumRemainingPercent,7);assert.equal(f.state.commands.length,0);
 f.controller.pause();await f.controller.updateConcurrency(3);assert.equal(f.controller.state.mode,'paused');assert.equal(new FleetController(f.config,f.deps).state.limits.concurrency,3);
});
test('lowering concurrency never interrupts busy workers, and new work remains blocked until usage drops',async t=>{
 const f=fixture(t);await f.controller.start();const result=await f.controller.updateConcurrency(1);assert.equal(result.capacity.used,2);assert.equal(result.capacity.free,0);assert.equal(f.state.commands.length,0);assert.equal(f.state.sessions.filter(s=>s.activity.state==='active').length,2);await assert.rejects(f.controller.dispatch('babytracker-3'),/Concurrency full: 2\/1/);
});
test('concurrency edits reject invalid input and do not bypass emergency or draining mode',async t=>{
 const f=fixture(t);for(const n of [0,33,2.5,'4',null,NaN])await assert.rejects(f.controller.updateConcurrency(n),/integer/);
 for(const mode of ['emergency','draining']){f.controller.state.mode=mode;await assert.rejects(f.controller.updateConcurrency(4),/recovery/);assert.equal(f.controller.state.limits.concurrency,2);}
 assert.equal(f.state.commands.length,0);
});
test('a native turn completing makes a slot available on the next read without clearing any ledger',async t=>{
 const f=fixture(t);await f.controller.start();assert.equal((await f.controller.snapshot()).capacity.free,0);f.state.sessions[1].activity.state='idle';const s=await f.controller.snapshot();assert.equal(s.capacity.free,1);assert.equal(s.sessions.find(x=>x.id==='babytracker-3').canDispatch,true);assert.equal(f.state.commands.length,0);
});
test('quota and model handoff blocks remain enforced even when capacity is available',async t=>{
 const f=fixture(t);await f.controller.start();await f.controller.updateConcurrency(4);f.controller.state.plans['babytracker-3']={status:'queued',harness:'agy'};assert.equal((await f.controller.snapshot()).sessions.find(x=>x.id==='babytracker-3').canDispatch,false);delete f.controller.state.plans['babytracker-3'];await f.controller.updateQuotaPolicy(15);const s=await f.controller.snapshot();assert.equal(s.quotaPolicy.blocked,true);assert.equal(s.sessions.find(x=>x.id==='babytracker-3').canDispatch,false);assert.equal(s.sessions.find(x=>x.id==='babytracker-3').label,'Blocked by policy');assert.equal(f.state.commands.length,0);
});

test('live concurrency endpoint retains same-origin/token defenses and makes no native calls',async t=>{
 const {createServer}=require('../server');const f=fixture(t);await f.controller.start();const before=structuredClone(f.controller.state.run);
 const server=createServer({config:f.config,controller:f.controller});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));const origin='http://127.0.0.1:'+server.address().port;
 const token=(await (await fetch(origin+'/api/session')).json()).token;
 const post=(suppliedToken=token,suppliedOrigin=origin,value=4)=>fetch(origin+'/api/action',{method:'POST',headers:{'Origin':suppliedOrigin,'Content-Type':'application/json','X-BabyTracker-Fleet':suppliedToken},body:JSON.stringify({action:'concurrency-policy',concurrency:value})});
 assert.equal((await post('bad')).status,403);assert.equal((await post(token,'https://evil.example')).status,403);assert.equal(f.controller.state.limits.concurrency,2);
 const response=await post();assert.equal(response.status,200);assert.equal((await response.json()).capacity.free,2);assert.deepEqual(f.controller.state.run,before);assert.equal(f.state.commands.length,0);
 assert.equal((await post(token,origin,33)).status,409);assert.equal(f.controller.state.limits.concurrency,4);
});
