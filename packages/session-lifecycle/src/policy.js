'use strict';
const {check,ident,sessionVersion}=require('./common');
function stopped(s,cfg,now){
 const reasons=[];if(!s||!ident(s.id)||s.projectId!==cfg.projectId)return ['outside_project'];
 if(s.kind!=='worker')reasons.push('primary_preserved');
 if(s.isTerminated!==false||s.activity?.state!=='exited'||s.provisionState!=='ready'||s.statusReadiness!=='ready')reasons.push('not_verified_stopped');
 if(s.isPinned)reasons.push('pinned');const times=[s.createdAt,s.updatedAt,s.activity?.lastActivityAt];
 if(times.some(v=>!Number.isFinite(Date.parse(v||''))||Date.parse(v)>now))reasons.push('unknown_native_age');else if(now-Math.max(Date.parse(s.createdAt),Date.parse(s.activity.lastActivityAt))<cfg.limits.minAgeHours*3600000)reasons.push('settling');return reasons;
}
function classify(s,facts,cfg,now=Date.now()){
 check(facts&&facts.complete===true&&facts.projectId===cfg.projectId,'incomplete_inventory');const reasons=stopped(s,cfg,now);
 if(facts.protectedIds.includes(s.id))reasons.push('preserved_recovery_target');if(facts.uncertainIds.includes(s.id))reasons.push('delivery_reconciliation');if(facts.replacingIds.includes(s.id))reasons.push('replacement_in_progress');
 const prs=facts.openPrs.filter(p=>(s.prs||[]).some(x=>x.number===p.number)||(p.headRefName&&(p.headRefName===s.branch||(s.branch?.endsWith('/root')&&p.headRefName.startsWith(s.branch.slice(0,-4))))));
 if(!Array.isArray(s.prs)||(s.prs||[]).some(p=>!Number.isSafeInteger(p.number)||!['open','draft','merged','closed'].includes(String(p.state).toLowerCase())))reasons.push('unknown_pr_associations');
 const holds=[...new Set(reasons)],successor=facts.sessions.filter(x=>x.projectId===cfg.projectId&&x.kind==='orchestrator'&&!x.isTerminated&&['idle','active','waiting_input','working'].includes(x.activity?.state)&&x.provisionState==='ready');
 const pendingWork=facts.taskOwners[s.id]||[],needsHandoff=prs.length>0||pendingWork.length>0||(s.artifactFiles||[]).length>0||s.branchState?.commits!==0||s.branchState?.unpushed!==0;
 return {id:s.id,version:sessionVersion(s),eligible:holds.length===0,reasons:holds,openPrs:prs.map(p=>p.number),needsHandoff,taskIds:pendingWork,successorId:cfg.transferToPrimary&&successor.length===1?successor[0].id:null};
}
module.exports={stopped,classify};
