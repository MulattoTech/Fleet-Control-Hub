'use strict';
const fs=require('node:fs');
const path=require('node:path');
const DEFAULT_MJOBS_ROOT='C:\\Tools\\AO-Fleet-Control';
function loadLedger(root,name){
  const file=path.join(root,name);
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2_000_000)throw Error('Ledger unavailable');
  const ledger=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
  if(ledger?.version!==1||!ledger.tasks||Array.isArray(ledger.tasks)||typeof ledger.tasks!=='object')throw Error('Ledger format changed');
  const tasks=Object.values(ledger.tasks);
  if(tasks.length>3000||tasks.some(t=>!t||typeof t!=='object'))throw Error('Ledger format changed');
  return ledger.tasks;
}
function readLedger(root,name){return Object.values(loadLedger(root,name));}
function tally(tasks,states){return tasks.filter(t=>states.includes(t.state)).length;}
function readMJobsProgress(root=process.env.MJOBS_CONTROL_ROOT||DEFAULT_MJOBS_ROOT){
  try{
    const reviews=readLedger(root,'artifact-review-state.json');
    const drafts=readLedger(root,'productive-work-state.json');
    return {available:true,
      reviews:{total:reviews.length,ready:tally(reviews,['review_ready']),inFlight:tally(reviews,['reserved','submitted','uncertain']),unassessed:reviews.filter(t=>t.acceptance==='unassessed').length},
      reviewDecisions:{available:true,awaitingAssessment:count(reviews,'acceptance',['unassessed']),accepted:count(reviews,'acceptance',['accepted']),revisionRequested:count(reviews,'acceptance',['revision_requested']),rejected:count(reviews,'acceptance',['rejected'])},
      drafts:{total:drafts.length,ready:tally(drafts,['artifact_ready']),inFlight:tally(drafts,['reserved','submitted','uncertain']),unreviewed:drafts.filter(t=>t.acceptance==='unreviewed').length}
    };
  }catch{return {available:false};}
}
function babyProgress(raw){
  if(!Array.isArray(raw.tasks))return {available:false};
  const tasks=raw.tasks;
  return {available:true,tasks:{total:tasks.length,proposed:tasks.filter(t=>t.status==='proposed').length,
    inFlight:tasks.filter(t=>['queued','submitted','submitting','awaiting_reconciliation'].includes(t.status)).length,
    accepted:tasks.filter(t=>t.status==='accepted').length,unassessed:tasks.filter(t=>t.acceptance==='NOT_ASSESSED').length},
    reviewDecisions:{available:true,awaitingAssessment:count(tasks,'acceptance',['NOT_ASSESSED']),
      accepted:raw.capabilities?.reviewAssessment===true?count(tasks,'acceptance',['ACCEPTED']):null,
      revisionRequested:raw.capabilities?.reviewAssessment===true?count(tasks,'acceptance',['REVISION_REQUESTED']):null,
      rejected:raw.capabilities?.reviewAssessment===true?count(tasks,'acceptance',['REJECTED']):null},
    pipeline:{available:true,proposed:count(tasks,'status',['proposed']),approved:null,active:count(tasks,'status',['submitting','submitted','awaiting_reconciliation']),
      completed:count(tasks,'status',['completed']),accepted:count(tasks,'status',['accepted']),blocked:count(tasks,'status',['blocked']),
      unassessed:count(tasks,'acceptance',['NOT_ASSESSED'])}};
}
function count(items,key,states){return items.filter(item=>states.includes(item?.[key])).length;}
function mjobsLifecycle(raw){
  if(!raw||!Array.isArray(raw.workItems))return {available:false};
  const items=raw.workItems;
  return {available:true,approved:items.filter(x=>x.state==='approved').length,
    leased:count(items,'state',['leased','dispatched','in_review']),completed:items.filter(x=>x.state==='completed').length,
    reviewReady:Number.isSafeInteger(raw.artifactReviews?.ready)?raw.artifactReviews.ready:null};
}
function mjobsPipeline(lifecycle,evidence){
  if(!lifecycle.available)return {available:false};
  return {available:true,proposed:null,approved:lifecycle.approved,active:lifecycle.leased,completed:lifecycle.completed,
    accepted:null,blocked:null,unassessed:evidence?.available?evidence.reviews.unassessed:null};
}
function readMJobsReviewCandidates({root=process.env.MJOBS_CONTROL_ROOT||DEFAULT_MJOBS_ROOT,offset=0,limit=50}={}){
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>3000)throw Error('Invalid review page');
  const rows=Object.entries(loadLedger(root,'artifact-review-state.json')).filter(([key,task])=>
    /^artifact-review:v1:[a-f0-9]{64}$|^artifact-review:v2:[a-f0-9]{40}:[1-3]$/.test(key)&&task.state==='review_ready'&&task.acceptance==='unassessed');
  return {supported:true,total:rows.length,offset,candidates:rows.slice(offset,offset+limit).map(([id,task])=>({id,outcome:['useful','needs_revision','duplicate','no_new_gap'].includes(task.outcome)?task.outcome:null}))};
}
module.exports={readMJobsProgress,babyProgress,mjobsLifecycle,mjobsPipeline,readMJobsReviewCandidates};
