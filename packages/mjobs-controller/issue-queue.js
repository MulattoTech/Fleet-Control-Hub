'use strict';
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const safeId=id=>typeof id==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(id);
const issueId=n=>Number.isSafeInteger(n)&&n>0;
const statuses=new Set(['reserved','submitted','uncertain']);
// Claims never expire: a lost response is not permission to replay.
class IssueQueue {
 constructor(root){this.file=path.join(root,'issue-ownership.json');}
 load(){
  try{
   if(fs.statSync(this.file).size>2*1024*1024)throw Error('Oversized ledger');
   const value=JSON.parse(fs.readFileSync(this.file,'utf8'));
   if(value.version!==1||!value.claims||typeof value.claims!=='object'||Array.isArray(value.claims)||Object.keys(value.claims).length>3000)throw Error('Invalid ledger');
   const owners=new Set();
   for(const [number,c]of Object.entries(value.claims)){
    if(!issueId(Number(number))||String(Number(number))!==number||!c||!safeId(c.agentId)||owners.has(c.agentId)||!statuses.has(c.status)||!Number.isFinite(Date.parse(c.at)))throw Error('Invalid claim');
    if(c.kind!==undefined&&!['send','spawn'].includes(c.kind))throw Error('Invalid operation');
    if(c.kind==='spawn'&&(!safeId(c.requestId)||typeof c.name!=='string'||!Array.isArray(c.previousIds)||!c.previousIds.every(safeId)||!['gpt-6-astra','gpt-6-sol','gpt-6-luna'].includes(c.model)||c.effort!=='medium'))throw Error('Invalid spawn claim');
    owners.add(c.agentId);
   }
   return value;
  }catch(e){if(e.code==='ENOENT')return {version:1,claims:{}};throw Error('Issue ownership unavailable; automatic assignment paused');}
 }
 transaction(change){
  let lock;
  try{
   lock=fs.openSync(this.file+'.lock','wx');const data=this.load(),result=change(data);if(result===false)return false;
   const tmp=this.file+'.'+randomUUID()+'.tmp';
   try{fs.writeFileSync(tmp,JSON.stringify(data,null,2),{flag:'wx'});fs.renameSync(tmp,this.file);}
   finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
   return result;
  }finally{if(lock!==undefined){fs.closeSync(lock);fs.unlinkSync(this.file+'.lock');}}
 }
 candidates(issues,sessions,openPRs){
  if(!Array.isArray(issues)||!Array.isArray(sessions)||!Array.isArray(openPRs))return [];
  const taken=new Set(Object.keys(this.load().claims).map(Number));
  for(const s of sessions){
   for(const n of [s.issueNumber,s.task?.issueNumber,s.assignment?.issueNumber,...(s.issueNumbers||[])])if(issueId(n))taken.add(n);
   for(const m of String(s.name||s.displayName||'').matchAll(/\bissue\s*#?(\d+)/gi))taken.add(Number(m[1]));
  }
  for(const pr of openPRs){
   for(const ref of pr.closingIssuesReferences||[])if(issueId(ref.number))taken.add(ref.number);
   for(const m of String(pr.body||'').matchAll(/(?:#|https:\/\/github\.com\/MulattoTech\/MJobs\/issues\/)(\d+)/gi))taken.add(Number(m[1]));
  }
  const result=[];
  for(const i of issues){
   if(!issueId(i?.number)||taken.has(i.number)||i.state!=='OPEN'||typeof i.title!=='string'||!i.title.trim()||!Array.isArray(i.assignees)||i.assignees.length)continue;
   if(/^(TalentHop Functional Parity|\[MJ-TH-FLEET\]|\[MJ-TH-RECON\])/i.test(i.title))continue;
   // Only explicit current P0/P1 labels authorize automatic work. Titles and
   // missing label data are not trusted to elevate lower-priority issues.
   if(!Array.isArray(i.labels))continue;
   const labels=i.labels.map(l=>typeof l==='string'?l:l?.name).filter(l=>typeof l==='string');
   const p0=labels.includes('priority:P0'),p1=labels.includes('priority:P1');
   if(p0===p1)continue;
   if(labels.some(l=>/in[ -]?progress|claimed|assigned|blocked|on[ -]?hold/i.test(l)))continue;
   // High-level bookkeeping/parent directives need primary review, not a new
   // coding worktree claimed as though they were an independent feature.
   if(labels.includes('category:bookkeeping')||labels.includes('category:major-feature'))continue;
   taken.add(i.number);result.push(i);
  }
  const priority=i=>i.labels.some(l=>(typeof l==='string'?l:l?.name)==='priority:P0')?0:1;
  return result.sort((a,b)=>priority(a)-priority(b)||a.number-b.number);
 }
 available(issues,sessions,openPRs){
  const claims=Object.values(this.load().claims),candidates=this.candidates(issues,sessions,openPRs);
  return sessions.filter(s=>s.kind==='worker'&&safeId(s.id)&&!s.isTerminated&&!s.replacedBy&&!s.openPRs&&!s.blocked&&!s.busy&&!s.frozen&&!s.dispatchPaused&&s.isIdle&&['idle','waiting_input'].includes(s.activity)&&!claims.some(c=>c.agentId===s.id))
   .slice(0,candidates.length).map((s,i)=>({agentId:s.id,issue:candidates[i]}));
 }
 reserve(number,agentId,now=Date.now(),operation={kind:'send'}){
  if(!issueId(number)||!safeId(agentId))throw Error('Invalid issue assignment');
  return this.transaction(data=>{
   if(data.claims[number]||Object.values(data.claims).some(c=>c.agentId===agentId))return false;
   data.claims[number]={...operation,agentId,status:'reserved',at:new Date(now).toISOString()};return true;
  });
 }
 mark(number,status,agentId){
  if(!statuses.has(status))throw Error('Invalid assignment outcome');
  return this.transaction(data=>{
   const claim=data.claims[number];if(!claim)throw Error('Issue claim missing');
   if(agentId!==undefined){
    if(!safeId(agentId)||Object.entries(data.claims).some(([n,c])=>Number(n)!==number&&c.agentId===agentId))throw Error('Worker already claimed');
    claim.agentId=agentId;
   }
   claim.status=status;return true;
  });
 }
}
module.exports={IssueQueue,safeId};
