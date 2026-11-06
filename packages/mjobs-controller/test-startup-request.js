'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {startWithVerifiedRecovery}=require('./startup-request');
const data={confirm:'STARTUP',requestId:'one-button-verified-001',startWorkAfter:true,openUi:false};
function fixture(previous={phase:'uncertain',runId:'old-run-verified',reconciliationRequired:true,active:false},proof={reconciled:true}){
 const calls=[];const startup={status:()=>previous,reconcile:async x=>{calls.push(['reconcile',x]);return proof;},start:opts=>{calls.push(['start',opts]);return {statusCode:202,run:{phase:'validating',runId:'new-run'}};}};
 const quota={status:()=>({policy:{blocked:false}})};
 return {startup,quota,calls};
}
test('single confirmed Startup rechecks the exact interrupted run before any new native work',async()=>{
 const f=fixture();const x=await startWithVerifiedRecovery({...f,data});
 assert.equal(x.statusCode,202);assert.equal(x.body.reconciledPrevious,true);
 assert.deepEqual(f.calls.map(c=>c[0]),['reconcile','start']);
 assert.equal(f.calls[0][1].runId,'old-run-verified');assert.equal(f.calls[1][1].requestId,data.requestId);
});
test('incomplete, pending, or failed Recheck cannot launch and retains original ledger',async()=>{
 for(const value of [{reconciled:false,pending:true,note:'Unverified process'},{reconciled:false,pending:false,note:'No bound receipt'},{reconciled:null}]){
  const f=fixture(undefined,value);const x=await startWithVerifiedRecovery({...f,data});
  assert.equal(x.statusCode,409);assert.deepEqual(f.calls.map(c=>c[0]),['reconcile']);
 }
});
test('no Recheck needed, normal explicit Startup submits only once',async()=>{
 const f=fixture({phase:'ready_paused',reconciliationRequired:false,active:false});const x=await startWithVerifiedRecovery({...f,data});
 assert.equal(x.statusCode,202);assert.equal(x.body.reconciledPrevious,false);assert.deepEqual(f.calls.map(c=>c[0]),['start']);
});
test('invalid confirmation and request identity do not even perform an inspection',async()=>{
 for(const patch of [{confirm:'OK'},{requestId:'short'},{requestId:'a'.repeat(129)},{openUi:'yes'},{startWorkAfter:1}]){
  const f=fixture();const x=await startWithVerifiedRecovery({...f,data:{...data,...patch}});
  assert.equal(x.statusCode,400);assert.equal(f.calls.length,0);
 }
});
test('low quota and unresolved owner fail closed before reconciliation',async()=>{
 const f=fixture();f.quota.status=()=>({policy:{blocked:true,reason:'10% below 15% threshold'}});
 const x=await startWithVerifiedRecovery({...f,data});assert.equal(x.statusCode,409);assert.equal(x.body.code,'QUOTA_BLOCKED');assert.equal(f.calls.length,0);
 const g=fixture({phase:'uncertain',runId:'old',reconciliationRequired:true,active:true});const y=await startWithVerifiedRecovery({...g,data});assert.equal(y.statusCode,409);assert.equal(g.calls.length,0);
});
