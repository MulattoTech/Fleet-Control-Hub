'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {Sustain}=require('./sustain');const {classify}=require('./work-state');
function fixture(t,count=7){const root=fs.mkdtempSync(path.join(os.tmpdir(),'productive-capacity-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));let now=Date.parse('2026-10-27T00:00:00Z'),cpu=10,hold=false,delay=null;
 const sessions=Array.from({length:count},(_,i)=>({id:i?'mjobs-worker-'+i:'mjobs-root',kind:i?'worker':'orchestrator',role:i?'Implementation':'Orchestration',name:'Fixture '+i,mode:'tui',isIdle:true,busy:false,activity:'idle',lastActivity:new Date(now-600000).toISOString(),prs:i?[{number:50+i,state:'draft'}]:[],openPRs:i?1:0}));
 const gh={fresh:true,open:sessions.slice(1).map((s,i)=>({number:51+i,headRefOid:String(i+1).repeat(40).slice(0,40),isDraft:true,statusCheckRollup:[{name:'CI',status:'IN_PROGRESS',conclusion:''}]}))};
 fs.writeFileSync(path.join(root,'productive-catalog.json'),JSON.stringify({version:1,baseCommit:'f'.repeat(40),entries:Array.from({length:20},(_,i)=>({path:'services/doc/module'+i+'.py',blob:(i+1).toString(16).padStart(40,'0'),missingDocstrings:2}))}));
 const sent=[];const engine=new Sustain({root,autoSchedule:false,clock:()=>now,getState:async()=>{if(delay)await delay;return {sessions,summary:{total:count,working:sessions.filter(s=>s.busy).length,idle:count},metrics:{}};},turbo:{signals:async()=>({freeRamGiB:17,freeDiskGiB:200,cpuPercent:cpu}),github:async()=>gh,running:false},command:async args=>{sent.push(args);return 'accepted';},isManualBusy:()=>hold,audit:()=>{}});
 engine.config={...engine.config,enabled:true,productiveWork:true,targetWorking:count,maxDispatchPerTick:4,intervalSeconds:30,minQuietSeconds:60};engine.nextTick=new Date(now+30000).toISOString();
 return {engine,sessions,sent,root,now:()=>now,advance:n=>{now+=n;},cpu:n=>{cpu=n;},hold:v=>{hold=v;},delay:v=>{delay=v;}};
}
test('an idle fleet with a full documentation catalog sends nothing without approved work',async t=>{
 const f=fixture(t);f.engine.config.targetWorking=31;f.engine.config.maxDispatchPerTick=12;
 for(let i=0;i<20;i++){const plan=await f.engine.preview();assert.equal(plan.proposed.length,0);const result=await f.engine.tick();assert.equal(result.sent.length,0);f.advance(30000);}
 assert.equal(f.sent.length,0);assert.equal(f.engine.productivity.summary().assigned,0);
});
test('one approved documentation work item dispatches once and persists its lifecycle',async t=>{
 const f=fixture(t),blob='1'.padStart(40,'0');
 assert.equal(f.engine.approveDocumentation(blob).state,'approved');
 assert.throws(()=>f.engine.approveDocumentation(blob),/already/);
 const plan=await f.engine.preview();assert.equal(plan.selected.length,1);assert.equal(plan.selected[0].type,'productive');
 assert.equal((await f.engine.tick()).sent.length,1);
 assert.equal(f.engine.productivity.load().approvals['productive:reference-v1:'+blob].state,'dispatched');
 f.advance(600000);for(const a of Object.values(f.engine.status.agents))a.awaiting=false;
 assert.equal((await f.engine.tick()).sent.length,0);
});
test('a verified receipt resolves uncertain documentation delivery without a second send',async t=>{
 const f=fixture(t),blob='1'.padStart(40,'0'),key='productive:reference-v1:'+blob;
 f.engine.approveDocumentation(blob);await f.engine.tick();
 const work=f.engine.productivity,task=work.load().tasks[key];work.finish(key,'uncertain');
 fs.writeFileSync(task.artifactPath,task.sourcePath+'\n'+blob+'\n'+('Verified contract. '.repeat(30)));
 fs.writeFileSync(task.resultPath,JSON.stringify({sourceBlob:blob,sourcePath:task.sourcePath,outcome:'documented',references:[task.sourcePath+':1-20']}));
 work.observe();assert.equal(work.load().tasks[key].state,'artifact_ready');assert.equal(work.load().approvals[key].state,'completed');
 f.advance(600000);for(const a of Object.values(f.engine.status.agents))a.awaiting=false;
 assert.equal((await f.engine.tick()).sent.length,0);assert.equal(f.sent.length,1);
});
test('future plans and ambiguous maintenance delivery never masquerade as busy',t=>{
 const f=fixture(t),s=f.sessions[1],c={config:f.engine.config,status:{agents:{}},latest:{at:new Date(f.now()+5000).toISOString(),proposed:[{id:s.id,etaSeconds:5}]}};
 assert.equal(classify(s,c,f.now()).state,'unknown');c.latest.at=new Date(f.now()).toISOString();c.productivity={summary:()=>({tasks:[{agentId:s.id,state:'uncertain',sourcePath:'services/doc/module.py'}]})};
 const result=classify(s,c,f.now());assert.equal(result.state,'queued');delete c.latest.proposed;const held=classify(s,c,f.now());assert.equal(held.state,'delivery_review');assert.equal(held.executing,false);assert.equal(held.estimatedStartAt,null);
});
test('productive policy attaches to a real existing UI region and stages all-worker settings without launching',()=>{
 const html=fs.readFileSync(path.join(__dirname,'public/index.html'),'utf8'),ui=fs.readFileSync(path.join(__dirname,'public/sustain-ui.js'),'utf8');assert(html.includes('id="turboSection"'));assert(ui.includes("getElementById('turboSection')"));assert(!ui.includes("getElementById('sustainSection')"));
 assert(ui.includes('productiveAll'));assert(ui.includes('Nothing has started yet.'));
});

test('completed maintenance receipts release only their matching delivery backoff',async t=>{
 for(const outcome of ['artifact_ready','no_new_gap'])await t.test(outcome,t=>{
  const f=fixture(t),s=f.sessions[1],sent=new Date(f.now()-300000).toISOString(),key='productive:reference-v1:'+('a'.repeat(40));
  f.engine.status.agents[s.id]={lastType:'productive',lastKey:key,lastSent:sent,awaiting:false,unverified:2,backoffReason:'unverified_delivery',backoffUntil:new Date(f.now()+720000).toISOString()};
  f.engine.latestProductiveTasks=[{id:key,agentId:s.id,state:outcome,completedAt:new Date(f.now()-10000).toISOString()}];
  f.engine.observe(f.sessions,{open:[]});const a=f.engine.status.agents[s.id];assert.equal(a.awaiting,false);assert.equal(a.unverified,0);assert.equal(a.backoffUntil,undefined);assert.equal(a.productiveReceiptKey,key);assert.equal(f.sent.length,0);
 });
});
test('unrelated, uncertain, stale-generation and future receipts never clear a delivery hold',async t=>{
 for(const kind of ['wrong-agent','wrong-key','uncertain','before-send','future','non-maintenance','busy','decision','other-hold'])await t.test(kind,t=>{
  const f=fixture(t),s=f.sessions[1],key='productive:reference-v1:'+('a'.repeat(40)),until=new Date(f.now()+720000).toISOString();
  const a=f.engine.status.agents[s.id]={lastType:'productive',lastKey:key,lastSent:new Date(f.now()-300000).toISOString(),awaiting:false,unverified:2,backoffReason:'unverified_delivery',backoffUntil:until};
  const r={id:key,agentId:s.id,state:'artifact_ready',completedAt:new Date(f.now()-10000).toISOString()};
  if(kind==='wrong-agent')r.agentId='someone-else';if(kind==='wrong-key')r.id+='other';if(kind==='uncertain')r.state='uncertain';if(kind==='before-send')r.completedAt=new Date(f.now()-600000).toISOString();if(kind==='future')r.completedAt=new Date(f.now()+10000).toISOString();if(kind==='non-maintenance')a.lastType='ci';
  if(kind==='busy'){s.busy=true;s.activity='active';s.isIdle=false;}
  if(kind==='decision'){s.activity='blocked';s.isIdle=false;}
  if(kind==='other-hold')a.backoffReason='operator_hold';
  f.engine.latestProductiveTasks=[r];f.engine.observe(f.sessions,{open:[]});
  if(kind==='busy'){assert.equal(a.awaiting,true);assert.equal(a.productiveReceiptKey,undefined,'Native execution, not a receipt, owns this active turn');}
  else assert.equal(a.backoffUntil,until);
  assert.equal(f.sent.length,0);
 });
});

test('shared delivery cooldown is planned as a wait, never reserved as an uncertain new task',async t=>{const f=fixture(t);const {DispatchLedger}=require('./dispatch-ledger');const ledger=new DispatchLedger({root:f.root,now:f.now});f.engine.deliveryLedger=ledger;const id=f.sessions[1].id,entry=ledger.reserve(id,'previous task');ledger.finish(id,entry.id,'submitted');f.advance(70000);const p=await f.engine.preview();assert(!p.proposed.some(x=>x.id===id));assert(p.held.some(x=>x.id===id&&x.kind==='delivery_cooldown'));assert.equal(f.engine.possibleDispatch(f.sessions[1],'productive','new-key','test','scope',f.now()),null);f.advance(51000);assert(f.engine.possibleDispatch(f.sessions[1],'productive','new-key','test','scope',f.now()));});
