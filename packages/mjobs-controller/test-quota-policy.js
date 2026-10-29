'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {minimumRemaining,policyStatus}=require('./quota-policy');
const {QuotaControl}=require('./quota-control');const {configRevision}=require('./quota-guard');const {StartupController}=require('./startup-control');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-quota-policy-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const q=new QuotaControl({root,autoSchedule:false});
 const stamp=()=>new Date().toISOString();fs.writeFileSync(q.configPath,JSON.stringify({enabled:true,pollSeconds:5,thresholdPercent:7,window:'any',autoKillArmed:true,tripped:false,updatedAt:stamp()}));
 const sample=(remaining=13)=>{const at=stamp();fs.writeFileSync(q.statusPath,JSON.stringify({status:'fresh',heartbeatAt:at,lastSuccessfulPoll:at,guardAck:{revision:configRevision(q.config()),appliedAt:at},windows:[{label:'Weekly',remainingPercent:remaining,resetsAt:new Date(Date.now()+86400000).toISOString()}]}));};sample();return {root,q,sample};}
test('zero reserve is the default, with explicit positive and zero choices preserved',()=>{
 assert.equal(minimumRemaining({thresholdPercent:7}),0);
 for(const value of [0,1,6,7,12,99])assert.equal(minimumRemaining({thresholdPercent:7,minimumRemainingPercent:value}),value);
 for(const value of [-1,100,NaN,'12',null])assert.equal(minimumRemaining({minimumRemainingPercent:value}),100);
 for(const remaining of [0,1,6,7,99])assert.equal(policyStatus({minimumRemainingPercent:0},{fresh:true,selectedRemainingPercent:remaining}).blocked,remaining===0);
 assert.equal(policyStatus({minimumRemainingPercent:0},{fresh:true,selectedRemainingPercent:1,ordinaryUsageAllowed:false}).blocked,true);
 assert.equal(policyStatus({minimumRemainingPercent:0},{fresh:false,selectedRemainingPercent:99}).blocked,true);
 assert.equal(policyStatus({thresholdPercent:7,autoKillArmed:true,minimumRemainingPercent:0},{fresh:true,selectedRemainingPercent:6}).blocked,true);
});
test('saved reserve changes dispatch and survives recreation without altering emergency choice',t=>{
 const f=fixture(t);f.q.update({minimumRemainingPercent:15});f.sample();assert.match(f.q.dispatchBlockReason(),/15%/);
 const before=f.q.config();f.q.update({minimumRemainingPercent:12});f.sample();
 assert.equal(f.q.config().thresholdPercent,7);assert.equal(f.q.config().autoKillArmed,true);assert.equal(f.q.dispatchBlockReason(),null);
 const again=new QuotaControl({root:f.root,autoSchedule:false});assert.equal(again.status().policy.minimumRemainingPercent,12);
 f.sample(12);assert.match(again.dispatchBlockReason(),/paused at 12%/);
 again.update({minimumRemainingPercent:0,thresholdPercent:0});again.disarm();f.sample(1);assert.equal(again.dispatchBlockReason(),null);
 f.sample(0);assert.match(again.dispatchBlockReason(),/safety brake/);
 for(const value of [-1,100,12.5,'12',null])assert.throws(()=>again.update({minimumRemainingPercent:value}),/limit/);
 assert.equal(again.config().minimumRemainingPercent,0);assert.equal(before.thresholdPercent,7);
});
test('normal Start enables monitoring and clears quota trip without arming or changing a positive reserve',t=>{
 const f=fixture(t);f.q.update({minimumRemainingPercent:15});
 fs.writeFileSync(f.q.configPath,JSON.stringify({...f.q.config(),enabled:false,tripped:true,autoKillArmed:true,triggeredAt:'old',triggerRemainingPercent:7}));
 f.q.prepareForStart();const prepared=f.q.config();
 assert.equal(prepared.enabled,true);assert.equal(prepared.tripped,false);assert.equal(prepared.autoKillArmed,false);assert.equal(prepared.minimumRemainingPercent,15);assert.equal(prepared.triggeredAt,undefined);
 const saved=fs.readFileSync(f.q.configPath,'utf8');f.q.prepareForStart();assert.equal(fs.readFileSync(f.q.configPath,'utf8'),saved,'Repeated Start does not churn the monitor revision');
 f.q.locked=()=>true;assert.throws(()=>f.q.prepareForStart(),/Emergency lockout/);assert.match(f.q.dispatchBlockReason(),/Emergency lockout/);assert.equal(fs.readFileSync(f.q.configPath,'utf8'),saved);
});
test('normal dispatch uses all positive quota while true zero, stale and provider denial remain blocked',t=>{
 const f=fixture(t);f.q.prepareForStart();
 for(const pct of [1,2,6,7,8]){f.sample(pct);assert.equal(f.q.dispatchBlockReason(),null);}
 f.sample(0);assert.match(f.q.dispatchBlockReason(),/safety brake/);
 f.sample(1);let data=JSON.parse(fs.readFileSync(f.q.statusPath));data.ordinaryUsageAllowed=false;fs.writeFileSync(f.q.statusPath,JSON.stringify(data));assert.match(f.q.dispatchBlockReason(),/ordinary usage/);
 data.ordinaryUsageAllowed=true;data.lastSuccessfulPoll=new Date(Date.now()-60000).toISOString();fs.writeFileSync(f.q.statusPath,JSON.stringify(data));assert.match(f.q.dispatchBlockReason(),/stale/);
 f.sample(1);assert.throws(()=>f.q.arm(),/emergency threshold/);f.q.update({thresholdPercent:0});assert.equal(f.q.arm().config.autoKillArmed,true);
});
function startupFixture(t,minimum,remaining){const f=fixture(t);const actions=[];const deps={safety:async()=>({quota:{fresh:true,remainingPercent:remaining,minimumRemainingPercent:minimum,armed:true,tripped:false,thresholdPercent:7,pollSeconds:5,window:'any',monitorEnabled:true},emergency:{latched:false},dispatchPaused:true}),bootstrap:async()=>({ok:true,targetCount:1,alreadyOnline:true}),holdDispatch:async()=>actions.push('hold'),unlock:async()=>actions.push('unlock'),watchdogDisarmed:async()=>true,arm:async()=>({armed:true,token:'fixture'}),guardAck:async()=>true,readiness:async()=>({ready:true}),restore:{start:async()=>{throw Error('must not restore');},status:async()=>({}),pause:async()=>{}}};return {...f,actions,startup:new StartupController({root:f.root,deps,pollMs:1})};}
test('Startup at 13% accepts an explicit 12% limit, but 13/15% limits block before mutations',async t=>{
 for(const min of [7,12,13,15])await t.test('minimum '+min,async t=>{const f=startupFixture(t,min,13);f.startup.start({confirm:'STARTUP',requestId:'quota-test-'+min,openUi:false});const result=await f.startup.waitForIdle();assert.equal(result.phase,min<13?'ready_paused':'failed');if(min>=13){assert.equal(result.error.code,'QUOTA_LOW');assert.deepEqual(f.actions,[]);}else assert.equal(result.policy.brakePercent,min);});
});
test('invalid saved Startup policy fails closed without changing any runtime',async t=>{const f=startupFixture(t,-1,13);f.startup.start({confirm:'STARTUP',requestId:'invalid-quota-policy'});const result=await f.startup.waitForIdle();assert.equal(result.error.code,'QUOTA_POLICY_INVALID');assert.deepEqual(f.actions,[]);});
