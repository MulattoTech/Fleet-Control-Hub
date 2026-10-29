'use strict';
const assert=require('node:assert/strict'),{preflight}=require('./preflight');
const fixture=()=>({quota:{fresh:true,guardAcknowledged:true,selectedRemainingPercent:90,ordinaryUsageAllowed:true,config:{enabled:true,autoKillArmed:true,tripped:false,thresholdPercent:7}},master:{emergency:{latched:false,remainingTotal:0},drain:{enabled:false},restore:{active:false}},snapshot:{offline:false}});
assert.equal(preflight(fixture()).ready,true);
for(const mutate of [
 x=>x.quota.fresh=false,x=>x.quota.selectedRemainingPercent=0,
 x=>x.quota.config.enabled=false,
 x=>x.quota.config.tripped=true,x=>x.quota.ordinaryUsageAllowed=false,
 x=>x.master.emergency.latched=true,x=>x.master.emergency.remainingTotal=1,
 x=>x.master.drain.enabled=true,x=>x.master.restore.active=true,
 x=>x.snapshot.offline=true,x=>x.quota.guardAcknowledged=false
]){
 const x=fixture();mutate(x);const result=preflight(x);
 assert.equal(result.ready,false);assert(result.issues.length>0);
 assert.equal(result.canSaveAgentPlans,true,'Configuration may remain staged while execution is blocked');
}
for(const remaining of [1,6,7,8,99]){
 const x=fixture();x.quota.selectedRemainingPercent=remaining;x.quota.config.autoKillArmed=false;x.quota.guardAcknowledged=false;
 assert.equal(preflight(x).ready,true,'Unarmed normal work accepts fresh '+remaining+'% with zero reserve');
}
for(const remaining of [null,undefined,NaN,Infinity,-1,101]){
 const x=fixture();x.quota.selectedRemainingPercent=remaining;x.quota.config.autoKillArmed=false;
 assert.equal(preflight(x).ready,false,'Invalid telemetry must fail closed');
}
{
 const x=fixture();x.quota.config.minimumRemainingPercent=15;x.quota.config.autoKillArmed=false;x.quota.selectedRemainingPercent=15;
 assert.equal(preflight(x).ready,false);x.quota.selectedRemainingPercent=16;assert.equal(preflight(x).ready,true);
 x.quota.config.minimumRemainingPercent=0;x.quota.config.autoKillArmed=true;x.quota.selectedRemainingPercent=6;
 assert(preflight(x).issues.some(issue=>issue.code==='EMERGENCY_THRESHOLD'));
 x.quota.config.autoKillArmed=false;assert.equal(preflight(x).ready,true);
 x.quota.config.tripped=true;const result=preflight(x);assert.equal(result.ready,false);assert.equal(result.bootstrapEligible,true,'Explicit Start can clear an old quota trip without arming');
}
console.log('PASS preflight: fresh healthy state, quota/guard/usage blocks, emergency, drain, restore and offline gates');
