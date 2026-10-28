'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {FleetController}=require('../controller');
const {PROJECT,SOURCE_REPO,ISSUE_REPO}=require('../config');
const CATALOG={providers:[
  {id:'codex',available:true,models:[{id:'gpt-6-luna',name:'Luna',efforts:['medium'],defaultEffort:'medium',effortMode:'flag'}]},
  {id:'agy',available:true,models:[{id:'gemini-3.8-flash-low',name:'Gemini Low',efforts:['low'],defaultEffort:'low',effortMode:'model-id'}]}
]};
function agent(id,harness='codex',projectId=PROJECT){return{id,projectId,kind:'worker',harness,displayName:id,activity:{state:'idle'},isTerminated:false};}
function fixture(t,options={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bt-multi-controller-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const state={sessions:[agent('baby-primary'),agent('mjobs-primary','codex','mjobs-luna')],quota:{fresh:true,remainingPercent:60},agy:{fresh:false,remainingPercent:null},provisions:[],commands:[],...options};
 const adapter={sessions:async()=>structuredClone(state.sessions),command:async(op,id,message,pre=()=>{})=>{
   const s=state.sessions.find(s=>s.id===id);pre(s);state.commands.push({op,id,message});
   if(op==='kill'||op==='exit')s.isTerminated=true;return {submitted:true};},
   provisionSelection:async(s,onSubmit)=>{
     onSubmit({existingIds:state.sessions.map(x=>x.id)});
     state.provisions.push(s);
     if(state.failProvision)throw Error('simulated native spawn timeout');
     const session={...agent('baby-created-'+state.provisions.length,s.harness),displayName:s.name,kind:s.kind,model:s.model};
     state.sessions.push(session);return {id:session.id,created:true};
   }};
 const config={projectId:PROJECT,sourceRepository:SOURCE_REPO,issueRepository:ISSUE_REPO,stateDir:dir,runtimeVerified:true};
 const deps={adapter,quota:()=>state.quota,agyUsage:async()=>state.agy,providers:async()=>CATALOG,resources:()=>({freeMemoryGiB:15,totalMemoryGiB:64,cpuPercent:null,diskIO:null})};
 const controller=new FleetController(config,deps);
 return{controller,state,config,deps,adapter};
}
const agy={name:'BabyTracker Gemini Worker',kind:'worker',harness:'agy',model:'gemini-3.8-flash-low',effort:'low',acknowledgeUnknownAgyQuota:true};
const codex={name:'BabyTracker Codex Worker',kind:'worker',harness:'codex',model:'gpt-6-luna',effort:'medium'};
test('explicit AGY creation works with unknown native quota, creates no paid task and excludes MJobs',async t=>{
 const f=fixture(t),mjobs=structuredClone(f.state.sessions[1]);
 await assert.rejects(f.controller.addAgent({...agy,acknowledgeUnknownAgyQuota:false}),/Acknowledge/);
 assert.equal(f.state.provisions.length,0);
 const result=await f.controller.addAgent(agy);
 assert.equal(result.sessionId,'baby-created-1');
 assert.equal(f.controller.state.provisioning.status,'verified');
 assert.equal(f.state.provisions[0].harness,'agy');
 assert.equal(f.state.commands.length,0);
 assert.equal(f.controller.state.mode,'paused');
 assert.deepEqual(f.state.sessions[1],mjobs);
 const s=await f.controller.snapshot();
 assert.equal(s.capabilities.explicitAgentProvisioning,true);
 assert.equal(s.agyUsage.remainingPercent,null);
});
test('AGY-only fleet can Start after Codex quota is exhausted; Codex agents cannot dispatch',async t=>{
 const f=fixture(t,{sessions:[agent('google-only','agy'),agent('mjobs-1','codex','mjobs-luna')],quota:{fresh:true,remainingPercent:2}});
 await f.controller.start();
 assert.equal(f.controller.state.mode,'running');
 await assert.rejects(f.controller.dispatch('google-only'),/manual turn/);
 const r=await f.controller.dispatch('google-only','find-work',{manualAgy:true});
 assert.equal(r.status,'submitted');assert.equal(f.state.commands.length,1);
 assert.equal(f.state.commands[0].id,'google-only');
});
test('AGY low observed quota blocks creation and manual dispatch; no auto quota claim',async t=>{
 const f=fixture(t,{agy:{fresh:true,remainingPercent:3}});
 await assert.rejects(f.controller.addAgent(agy),/AGY quota/);
 assert.equal(f.state.provisions.length,0);
 f.state.sessions.push(agent('google-only','agy'));await f.controller.start();
 await assert.rejects(f.controller.dispatch('google-only','find-work',{manualAgy:true}),/AGY quota/);
 assert.equal(f.state.commands.length,0);
});
test('Codex quota requirement survives multi-provider changes and protects provisioning',async t=>{
 const f=fixture(t,{quota:{fresh:false,remainingPercent:null,reason:'stale Codex telemetry'}});
 await assert.rejects(f.controller.addAgent(codex),/stale Codex/);
 assert.equal(f.state.provisions.length,0);
 await assert.rejects(f.controller.start(),/stale Codex/);
});
test('live agent cap, duplicate orchestrator, and emergency latch block further creation',async t=>{
 const f=fixture(t);
 f.controller.limits({maxAgents:1});
 await assert.rejects(f.controller.addAgent(agy),/Maximum project agent/);
 f.controller.limits({maxAgents:3});
 f.state.sessions[0].kind='orchestrator';
 await assert.rejects(f.controller.addAgent({...agy,kind:'orchestrator'}),/orchestrator already/);
 await f.controller.stop(true);
 await assert.rejects(f.controller.addAgent(agy),/emergency/);
});
test('uncertain provision persists and reconciliation identifies exact native project session',async t=>{
 const f=fixture(t,{failProvision:true});
 await assert.rejects(f.controller.addAgent(agy),/reconcile before retrying/);
 assert.equal(f.controller.state.provisioning.status,'uncertain');
 await assert.rejects(f.controller.addAgent(agy),/needs reconciliation/);
 await assert.rejects(f.controller.reconcileAgentSpawn(),/not verified/);
 f.state.sessions.push({...agent('baby-manual-found','agy'),displayName:agy.name,kind:'worker'});
 const result=await f.controller.reconcileAgentSpawn();
 assert.equal(result.sessionId,'baby-manual-found');
 assert.equal(f.controller.state.provisioning.status,'verified');
 const restarted=new FleetController(f.config,f.deps);
 assert.equal(restarted.state.provisioning.status,'verified');
 assert.equal(f.state.provisions.length,1);
});
test('All Hands and Turbo never send AGY work automatically when its percentage cutoff is unverified',async t=>{
 const f=fixture(t,{sessions:[agent('google-only','agy')]});
 await f.controller.start();
 const result=await f.controller.allHands();
 assert.equal(result.results.length,0);
 f.controller.turbo(true);
 await f.controller.tick();
 assert.equal(f.state.commands.length,0);
});

test('Codex-only automatic run pauses on quota loss, preserving the prior safety brake',async t=>{
 const f=fixture(t,{sessions:[agent('codex-only')],quota:{fresh:true,remainingPercent:50}});
 await f.controller.start();
 f.state.quota={fresh:true,remainingPercent:5};
 await f.controller.tick();
 assert.equal(f.controller.state.mode,'paused');
 assert.equal(f.state.commands.length,0);
});
test('Mixed fleets suspend Codex Turbo at quota brake without authorizing automatic AGY turns',async t=>{
 const f=fixture(t,{sessions:[agent('codex-1'),agent('google-1','agy')],quota:{fresh:true,remainingPercent:50}});
 await f.controller.start();
 f.controller.turbo(true);
 f.state.quota={fresh:true,remainingPercent:3};
 await f.controller.tick();
 assert.equal(f.controller.state.mode,'running');
 assert.equal(f.controller.state.run.turbo,false);
 assert.equal(f.state.commands.length,0);
});

test('failed AGY TUI creation can be explicitly reconciled only after two session reads and 30 seconds',async t=>{
 const f=fixture(t,{failProvision:true});
 await assert.rejects(f.controller.addAgent(agy),/reconcile before retrying/);
 assert.equal(f.controller.state.provisioning.status,'uncertain');
 await assert.rejects(f.controller.reconcileAgentSpawn({confirmNoSession:true}),/30 seconds/);
 f.controller.state.provisioning.at=new Date(Date.now()-65000).toISOString();
 f.controller.save();
 const result=await f.controller.reconcileAgentSpawn({confirmNoSession:true});
 assert.match(result.note,/No BabyTracker agent was created/);
 assert.equal(f.controller.state.provisioning.status,'rejected');
 f.state.failProvision=false;
 const success=await f.controller.addAgent(agy);
 assert.equal(success.ok,true);
 assert.equal(f.state.provisions.length,2);
});
test('cannot clear uncertain spawn when any new BabyTracker session exists, even a terminated or unrelated one',async t=>{
 const f=fixture(t,{failProvision:true});
 await assert.rejects(f.controller.addAgent(agy),/unverified/);
 f.controller.state.provisioning.at=new Date(Date.now()-65000).toISOString();
 f.controller.save();
 f.state.sessions.push({...agent('babytrack-foreign','codex'),isTerminated:true,displayName:'Different project worker'});
 await assert.rejects(f.controller.reconcileAgentSpawn({confirmNoSession:true}),/session was not verified/);
 assert.equal(f.controller.state.provisioning.status,'uncertain');
});
