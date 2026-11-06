'use strict';
// A single user-confirmed Start can incorporate the existing read-only Recheck.
// Failed proof never authorizes a new restore or modifies the durable ledger.
async function startWithVerifiedRecovery({startup,quota,data}){
 if(data?.confirm!=='STARTUP'||typeof data.requestId!=='string'||
    !/^[A-Za-z0-9._:-]{8,128}$/.test(data.requestId)||
    (data.startWorkAfter!==undefined&&typeof data.startWorkAfter!=='boolean')||
    (data.openUi!==undefined&&typeof data.openUi!=='boolean'))
  return {statusCode:400,body:{error:'A valid explicit STARTUP confirmation and stable request ID are required',code:'CONFIRMATION_REQUIRED'}};
 const policy=quota.status().policy;
 if(policy?.blocked===true)return {statusCode:409,body:{error:policy.reason,code:'QUOTA_BLOCKED',quotaPolicy:policy}};
 const previous=startup.status();let recovered=false;
 if(previous.reconciliationRequired===true||previous.phase==='uncertain'){
  if(previous.active||!previous.runId)return {statusCode:409,body:{error:'A settled prior Startup is not identified',code:'RECOVERY_UNCERTAIN'}};
  const proof=await startup.reconcile({confirm:'RECHECK STARTUP',runId:previous.runId});
  if(proof.reconciled!==true)return {statusCode:409,body:{error:proof.note||'Exact recovery evidence is incomplete; no launch submitted',code:'RECOVERY_EVIDENCE_INCOMPLETE',run:proof.run}};
  recovered=true;
 }
 const result=startup.start(data);
 return {statusCode:result.statusCode,body:{...result,reconciledPrevious:recovered}};
}
module.exports={startWithVerifiedRecovery};
