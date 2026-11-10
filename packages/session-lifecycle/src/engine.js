'use strict';
const {classify}=require('./policy');
const {check,digest,plainError,identity,assertCustodian}=require('./common');
class Lifecycle{
 constructor({config,store,adapter,capsules,clock=Date.now}){Object.assign(this,{config,store,adapter,capsules,clock});}
 async run({dryRun=false}={}){
  if(!this.config.enabled)return {enabled:false,projectId:this.config.projectId};this.store.acquire();
  try{
   const facts=await this.adapter.inspect(),{config:cfg,store}=this;check(facts.complete===true&&facts.projectId===cfg.projectId,'incomplete_inventory');await this.adapter.guard();let processed=0;const inventory=[];
   for(const job of dryRun?[]:Object.values(store.data.jobs)){if(job.stage==='archived'||job.operation?.name!=='archive'||job.operation.status==='observed')continue;const native=facts.sessions.find(s=>s.id===job.id);if(native?.isTerminated&&digest(identity(native))===digest(job.identity)){this.capsules.verify(job.bundle);store.observed(job,{recovered:true});this.finish(job);}}
   for(const s of [...facts.sessions].sort((a,b)=>Date.parse(a.updatedAt)-Date.parse(b.updatedAt))){
    if(s.projectId!==cfg.projectId||s.isTerminated)continue;const plan=classify(s,facts,cfg,this.clock());inventory.push({id:s.id,eligible:plan.eligible,reasons:plan.reasons});
    if(!plan.eligible||processed>=cfg.limits.maxBatch)continue;if(dryRun){processed++;continue;}
    const job=store.job(s);if(job.stage==='archived'||(job.retryAt&&Date.parse(job.retryAt)>this.clock()))continue;processed++;
    try{await this.advance(job,s,plan,facts);job.reason=null;job.retryAt=null;store.data.serviceReason=null;store.save();}catch(error){store.defer(job,plainError(error),cfg.limits.retryMinutes);}
   }
   if(!dryRun){store.data.lastRunAt=new Date(this.clock()).toISOString();store.data.lastInventory=inventory;store.save();}
   return {...store.summary(),enabled:true,dryRun,examined:inventory.length,processed,eligible:inventory.filter(x=>x.eligible).length,inventory};
  }catch(error){if(!dryRun){this.store.data.lastAttemptAt=new Date(this.clock()).toISOString();this.store.data.serviceReason=plainError(error);this.store.save();}throw error;}finally{this.store.release();}
 }
 async fresh(job,{permitClaimChanges=false}={}){
  await this.adapter.guard();const facts=await this.adapter.inspect(),candidates=facts.sessions.filter(s=>s.id===job.id);check(candidates.length===1,'native_identity_changed');const s=candidates[0];check(digest(identity(s))===digest(job.identity),'native_identity_changed');
  if(s.isTerminated&&job.operation?.name==='archive')return {archived:true,facts,session:s};
  const plan=classify(s,facts,this.config,this.clock());check(plan.eligible,plan.reasons[0]||'native_state_changed');if(!permitClaimChanges)check(plan.version===job.version,'native_state_changed');check(plan.openPrs.every(n=>job.openPrs.includes(n)),'new_pr_ownership');check(plan.taskIds.every(t=>job.taskIds.some(previous=>digest(previous)===digest(t))),'new_task_ownership');
  if(job.bundle){this.capsules.verify(job.bundle);check(await this.adapter.contentFingerprint(s)===job.bundle.sourceFingerprint,'workspace_changed_after_snapshot');}return {facts,session:s,plan};
 }
 async advance(job,s,plan,facts){
  const {store,adapter,capsules}=this;
  if(!job.identity){Object.assign(job,{identity:identity(s),version:plan.version,openPrs:plan.openPrs,taskIds:plan.taskIds,needsHandoff:plan.needsHandoff});store.record('discovered',job.id);}
  if(!job.bundle){await this.fresh(job);job.stage='snapshotting';store.save();const bundle=await capsules.capture(s,job,facts);await this.fresh(job);job.bundle=bundle;job.stage='preserved';store.record('preserved',job.id,{capsuleId:bundle.id,manifestSha256:bundle.manifestSha256});}
  if(!job.custodyId){const custodian=plan.needsHandoff?plan.successorId:null;if(plan.needsHandoff)check(custodian,'awaiting_project_custodian');const owner=custodian||'project:'+this.config.projectId,successor=custodian?facts.sessions.find(x=>x.id===custodian):null;job.owner=owner;job.ownerIdentity=successor?identity(successor):null;job.custodyId=digest([this.config.projectId,job.key,job.bundle.manifestSha256,owner]);store.data.custody[job.custodyId]={id:job.custodyId,projectId:this.config.projectId,from:job.id,owner,ownerIdentity:job.ownerIdentity,capsule:job.bundle,openPrs:job.openPrs,tasks:job.taskIds,state:'preserved',acceptedAt:null};job.stage='handoff';store.record('custody_recorded',job.id,{custodyId:job.custodyId,owner});}
  const custody=store.data.custody[job.custodyId];check(custody&&custody.capsule.manifestSha256===job.bundle.manifestSha256,'custody_record_changed');
  if(job.ownerIdentity){
   const observed=await this.fresh(job,{permitClaimChanges:true});assertCustodian(job,observed.facts.sessions);
   for(const number of job.openPrs){
    if(job.claims[number]?.verified)continue;
    if(job.operation&&job.operation.status!=='observed'){check(job.operation.name==='claim-pr'&&job.operation.target===number,'operation_outcome_unknown');check(await adapter.claimObserved(job,number),'ownership_verification_pending');store.observed(job,{number,owner:job.owner});job.claims[number]={verified:true};store.save();continue;}
    const current=await this.fresh(job,{permitClaimChanges:true});if(!current.plan.openPrs.includes(number)){job.claims[number]={verified:true,closed:true};store.save();continue;}check(await adapter.claimAllowed(job,number,current.facts),'ownership_conflict');store.intent(job,'claim-pr',number);await adapter.claim(job,number);store.save();check(await adapter.claimObserved(job,number),'ownership_verification_pending');store.observed(job,{number,owner:job.owner});job.claims[number]={verified:true};store.save();
   }
   if(!job.handoffAccepted){
    if(!job.handoffMessage){job.handoffMessage=adapter.handoffMessage(job,capsules.handoffPath(job.bundle));store.save();}
    if(job.operation&&job.operation.status!=='observed'){check(job.operation.name==='handoff','operation_outcome_unknown');check(await adapter.handoffObserved(job),'handoff_delivery_pending');store.observed(job);job.handoffAccepted=true;store.save();}
    else{await this.fresh(job,{permitClaimChanges:true});if(adapter.handoffPreflight)await adapter.handoffPreflight();store.intent(job,'handoff',job.owner);await adapter.handoff(job);check(await adapter.handoffObserved(job),'handoff_delivery_pending');store.observed(job);job.handoffAccepted=true;store.save();}
   }
  }
  custody.state='accepted';custody.acceptedAt||=new Date(this.clock()).toISOString();job.stage='retiring';store.save();const last=await this.fresh(job,{permitClaimChanges:true});
  if(last.archived){store.observed(job);return this.finish(job);}assertCustodian(job,last.facts.sessions);for(const number of last.plan.openPrs)check(job.claims[number]?.verified&&await adapter.claimObserved(job,number),'ownership_verification_pending');if(job.operation&&job.operation.status!=='observed')check(false,'archive_outcome_pending');store.intent(job,'archive',job.id);await adapter.archive(job,last.session);check(await adapter.archived(job),'archive_outcome_pending');store.observed(job);this.finish(job);
 }
 finish(job){job.stage='archived';job.archivedAt=new Date(this.clock()).toISOString();this.store.record('archived',job.id,{custodyId:job.custodyId});}
}
module.exports={Lifecycle};
