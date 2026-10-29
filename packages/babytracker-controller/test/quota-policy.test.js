'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {FleetController}=require('../controller');const {PROJECT,SOURCE_REPO,ISSUE_REPO}=require('../config');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'baby-quota-policy-'));t.after(()=>fs.rmSync(root,{force:true,recursive:true}));const state={remaining:13,fresh:true,commands:[],shared:7};const config={projectId:PROJECT,sourceRepository:SOURCE_REPO,issueRepository:ISSUE_REPO,stateDir:root,runtimeVerified:true};
 const deps={adapter:{sessions:async()=>[{id:'baby-worker',projectId:PROJECT,kind:'worker',harness:'codex',activity:{state:'idle'},isTerminated:false}],command:async(...args)=>state.commands.push(args)},quota:()=>({fresh:state.fresh,remainingPercent:state.remaining,sharedEmergencyGuard:{thresholdPercent:state.shared,armed:true}}),resources:()=>({freeMemoryGiB:12,totalMemoryGiB:32})};return {state,config,deps,controller:new FleetController(config,deps)};}
test('quota remains visible while paused and threshold changes are project-local with no launch',async t=>{const f=fixture(t);const before=await f.controller.snapshot();assert.equal(before.mode,'paused');assert.equal(before.quotaPolicy.blocked,true);assert.match(before.quotaPolicy.reason,/13%.*20%/);
 await f.controller.updateQuotaPolicy(12);const snap=await f.controller.snapshot();assert.equal(snap.mode,'paused');assert.equal(snap.quotaPolicy.blocked,false);assert.equal(snap.quotaPolicy.minimumRemainingPercent,12);assert.equal(f.state.commands.length,0);
 const recreated=new FleetController(f.config,f.deps);assert.equal(recreated.state.limits.minimumRemainingPercent,12);assert.equal(recreated.quotaPolicy().sharedEmergencyGuard.thresholdPercent,7);
 f.state.remaining=12;assert.equal(recreated.quotaPolicy().blocked,true);assert.match(recreated.guard({requireRunning:false,session:{harness:'codex'}}),/QUOTA HOLD/);
});
test('zero reserve persists independently of shared guard and allows only fresh positive quota',async t=>{
 const f=fixture(t);
 for(const x of [-1,100,12.5,'12',null])await assert.rejects(f.controller.updateQuotaPolicy(x),/limit/);
 await f.controller.updateQuotaPolicy(0);
 const recreated=new FleetController(f.config,f.deps);
 assert.equal(recreated.state.limits.minimumRemainingPercent,0);
 f.state.shared=15;f.state.remaining=1;
 assert.equal(recreated.quotaPolicy().minimumAllowedPercent,0);
 assert.equal(recreated.quotaPolicy().minimumRemainingPercent,0);
 assert.equal(recreated.quotaPolicy().blocked,false);
 assert.equal(recreated.quotaPolicy().sharedEmergencyGuard.thresholdPercent,15);
 await recreated.simpleStart();assert.equal(recreated.state.mode,'running');
 recreated.pause();f.state.remaining=0;
 await assert.rejects(recreated.simpleStart(),/QUOTA HOLD/);
 f.state.remaining=1;f.state.fresh=false;
 await assert.rejects(recreated.simpleStart(),/Fresh Codex/);
 assert.equal(f.state.commands.length,0);
});
test('limits form also saves zero reserve without modifying shared protection',async t=>{
 const f=fixture(t);f.controller.limits({minimumRemainingPercent:0});
 assert.equal(f.controller.state.limits.minimumRemainingPercent,0);
 assert.equal(f.controller.quotaPolicy().sharedEmergencyGuard.thresholdPercent,7);
 assert.equal(f.controller.state.mode,'paused');
});
test('configured low-quota Startup is blocked before provisioning or native dispatch; changing policy alone keeps pause',async t=>{const f=fixture(t);await assert.rejects(f.controller.start(),/QUOTA HOLD/);assert.equal(f.state.commands.length,0);await f.controller.updateQuotaPolicy(12);assert.equal(f.controller.state.mode,'paused');await f.controller.start();assert.equal(f.controller.state.mode,'running');assert.equal(f.state.commands.length,0);});
