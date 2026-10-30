'use strict';
// Inert scheduler/ledger fixtures only; no AO, network, or provider work.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {Turbo}=require('./turbo');
const {DispatchLedger}=require('./dispatch-ledger');
const NOW=Date.parse('2026-10-30T12:00:00Z');
const session=(id,role='Fast implementation',extra={})=>({id,name:id,kind:'worker',role,mode:'chat',activity:'idle',isIdle:true,busy:false,openPRs:0,prs:[],...extra});
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'turbo-fairness-'));
 const primary=session('mjobs-luna-116','Orchestration',{kind:'orchestrator',activity:'active',isIdle:false,busy:true});
 const snapshot={timestamp:new Date(NOW).toISOString(),sessions:[primary],metrics:{ramFree:20*1024**3,cpu:10},summary:{working:1,idle:0,idleFree:0}};
 const github={open:[],merged:[]},sent=[];
 const turbo=new Turbo({root,getState:async()=>snapshot,command:async args=>{sent.push(args);return 'ok';},audit:()=>{},clock:()=>NOW,githubRunner:async()=>github,autoSchedule:false});
 // Resource values are deterministic; production resource/quota gates are unchanged.
 turbo.signals=async()=>({freeRamGiB:20,freeDiskGiB:100,cpuPercent:10,pausedReason:null});
 turbo.deliveryLedger=new DispatchLedger({root,now:()=>NOW});
 const hold=(id,status)=>{const row=turbo.deliveryLedger.reserve(id,'unresolved prior instruction');if(status!=='reserved')turbo.deliveryLedger.finish(id,row.id,status);};
 return {root,primary,snapshot,github,sent,turbo,hold,close:()=>fs.rmSync(root,{recursive:true,force:true})};
}
async function run(){
 let f=fixture();
 try{
  f.snapshot.sessions.push(session('mjobs-luna-119','Orchestration'),session('mjobs-luna-121','Orchestration'),session('mjobs-luna-120'),session('mjobs-luna-122','Architecture',{frozen:true}));
  f.hold('mjobs-luna-119','uncertain');f.hold('mjobs-luna-121','reserved');
  const before=fs.readFileSync(f.turbo.deliveryLedger.file,'utf8');
  f.turbo.config.maxActionsPerCycle=1;f.turbo.config.maxActionsPerHour=1;
  const preview=await f.turbo.preview();
  assert.deepEqual(preview.preview.nextActions.map(x=>x.id),['mjobs-luna-120'],'held coordinators cannot consume the only cycle slot');
  assert.equal(f.turbo.session.actions.length,0,'preview creates no dispatch attempts');
  const plan=f.turbo.previewTextPlan(f.snapshot,f.github,NOW);
  assert.match(plan.plan[0].message,/primary orchestrator mjobs-luna-116/);
  assert.doesNotMatch(plan.plan[0].message,/mjobs-luna-(34|35|122)\b/);
  const result=await f.turbo.cycle({manual:true});
  assert.deepEqual(result.executed.map(x=>x.id),['mjobs-luna-120']);
  assert.equal(f.turbo.summary().sentThisHour,1,'only the actual attempt consumes the hourly budget');
  assert.equal(f.turbo.dispatchSignals.seen('refill:mjobs-luna-122'),false,'frozen workers do not receive refill signals');
  assert.equal(fs.readFileSync(f.turbo.deliveryLedger.file,'utf8'),before,'unknown delivery evidence is preserved byte-for-byte');
 }finally{f.close();}
 f=fixture();
 try{
  f.snapshot.sessions.push(session('mjobs-luna-119','Critical review'),session('mjobs-luna-120','Critical review'),session('mjobs-luna-123','Fast implementation',{openPRs:1,prs:[{number:44,state:'open',ci:'passing'}]}));
  f.hold('mjobs-luna-119','uncertain');
  f.github.open.push({number:44,headRefOid:'a'.repeat(40),reviewDecision:'',statusCheckRollup:[{status:'COMPLETED',conclusion:'SUCCESS'}]});
  const plan=f.turbo.previewTextPlan(f.snapshot,f.github,NOW);
  assert.equal(plan.plan.find(x=>x.kind==='review').id,'mjobs-luna-120','a held first reviewer cannot starve another reviewer');
  assert.match(plan.plan.find(x=>x.kind==='review').message,/primary mjobs-luna-116/);
 }finally{f.close();}
 f=fixture();
 try{
  f.snapshot.sessions.push(session('mjobs-luna-120'),session('mjobs-luna-123'));
  let reads=0;
  f.turbo.getState=async()=>{if(++reads===2)f.hold('mjobs-luna-120','reserved');return f.snapshot;};
  const result=await f.turbo.cycle({manual:true});
  assert.deepEqual(result.executed.map(x=>x.id),['mjobs-luna-123'],'a hold introduced after planning does not block a healthy peer');
  assert.equal(f.turbo.summary().sentThisHour,1);
  assert.equal(f.turbo.dispatchSignals.seen('refill:mjobs-luna-120'),false,'race is rechecked before creating signal or attempt');
  assert.equal(f.turbo.deliveryLedger.entries['mjobs-luna-120'].status,'reserved');
 }finally{f.close();}
 f=fixture();
 try{
  f.snapshot.sessions.push(session('mjobs-luna-120'));
  let reads=0;
  f.turbo.getState=async()=>{if(++reads===2)f.primary.id='mjobs-luna-117';return f.snapshot;};
  const result=await f.turbo.cycle({manual:true});
  assert.deepEqual(result.executed,[],'a changed primary invalidates the old recipient instruction');
  assert.equal(f.turbo.session.actions.length,0);
  f.snapshot.sessions.push(session('mjobs-luna-118','Orchestration',{kind:'orchestrator'}));
  const plan=f.turbo.previewTextPlan(f.snapshot,f.github,NOW);
  assert.equal(plan.rootId,null);assert.deepEqual(plan.plan,[]);assert.match(plan.blocked,/ambiguous/);
 }finally{f.close();}
 f=fixture();
 try{
  f.snapshot.sessions.push(session('mjobs-luna-120'),session('mjobs-luna-122','Architecture',{dispatchPaused:true}));
  const preview=await f.turbo.makeAllHandsPlan();
  assert.deepEqual(preview.plan.map(x=>x.id),['mjobs-luna-120']);
  assert.match(preview.plan[0].message,/from mjobs-luna-116/);assert.doesNotMatch(preview.plan[0].message,/mjobs-luna-(34|35)\b/);
  let reads=0;f.turbo.getState=async()=>{if(++reads===2)f.hold('mjobs-luna-120','uncertain');return f.snapshot;};
  const result=await f.turbo.allHands();
  assert.equal(result.submitted,0);assert.equal(result.skipped,1);assert.equal(result.attempted,0);
  assert.equal(f.turbo.session.actions.length,0);
 }finally{f.close();}
 console.log('PASS Turbo delivery fairness: held recipients, reviewer selection, preserved receipts, frozen workers, current-primary payloads and pre-send races');
}
if(require.main===module)run().catch(e=>{console.error(e.stack);process.exitCode=1;});
module.exports=run;
