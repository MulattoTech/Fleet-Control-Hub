'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const digest=x=>crypto.createHash('sha256').update(x).digest('hex');
class SessionGovernor {
 constructor({root,projectId='mjobs-luna',listSessions,getSession,exitAgent,pauseDispatch=()=>{},audit=()=>{},now=Date.now}){
  Object.assign(this,{root,projectId,listSessions,getSession,exitAgent,pauseDispatch,audit,now});
  this.inFlight=false;this.timer=null;this.violations=[];this.last={enabled:false,checkedAt:null,unapproved:[],paused:false,error:null,verifiedExits:0};
 }
 policy(){
  const bytes=fs.readFileSync(path.join(this.root,'startup-selection.json'));
  const value=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));
  if(value.version!==1||value.projectId!==this.projectId||value.enforceLiveRoster!==true||
     !Array.isArray(value.sessionIds)||value.sessionIds.length===0||value.sessionIds.length>32||
     value.maxSessions!==value.sessionIds.length||new Set(value.sessionIds).size!==value.sessionIds.length||
     !value.sessionIds.includes(value.primaryId)||value.sessionIds.some(id=>!/^mjobs-luna-[0-9]+$/.test(id)))throw Error('Strict MJobs session policy is unavailable');
  return {value,sha:digest(bytes),ids:new Set(value.sessionIds)};
 }
 status(){return structuredClone({...this.last,inFlight:this.inFlight,recentViolations:this.violations.slice(-8)});}
 async check(){
  if(this.inFlight)return {skipped:'inspection-in-progress'};
  this.inFlight=true;
  try{
   const original=this.policy(),list=await this.listSessions();
   if(!Array.isArray(list))throw Error('Native session inventory is unavailable');
   const ids=new Set();
   for(const item of list){if(!item||typeof item.id!=='string'||ids.has(item.id))throw Error('Duplicate or invalid native session identity');ids.add(item.id);}
   const unexpected=list.filter(s=>s.projectId===this.projectId&&!s.isTerminated&&
    ['active','working','idle','waiting_input','blocked'].includes(s.activity?.state)&&!original.ids.has(s.id));
   const result={enabled:true,checkedAt:new Date(this.now()).toISOString(),unapproved:unexpected.map(s=>s.id),paused:this.last.paused,error:null,verifiedExits:0,selected:original.ids.size,observedLive:list.filter(s=>s.projectId===this.projectId&&!s.isTerminated&&s.activity?.state!=='exited').length};
   for(const suspect of unexpected){
    if(this.policy().sha!==original.sha)throw Error('Session scope policy changed during inspection');
    const current=await this.getSession(suspect.id);
    const s=current?.session||current;
    if(!s||s.id!==suspect.id||s.projectId!==this.projectId||s.createdAt!==suspect.createdAt||s.isTerminated||s.activity?.state==='exited')continue;
    const key=s.id+':'+s.createdAt;
    if(this.violations.some(e=>e.key===key))continue;
    this.audit('session_scope_unapproved',{id:s.id,createdAt:s.createdAt,selectedCount:original.ids.size});
    const response=await this.exitAgent(s.id);
    if(response?.ok!==true)throw Error('Unable to safely exit unapproved MJobs session '+s.id);
    let after=await this.getSession(s.id);after=after?.session||after;
    if(after?.activity?.state!=='exited')throw Error('Native exit is not confirmed for unapproved session '+s.id);
    const entry={key,id:s.id,createdAt:s.createdAt,at:new Date(this.now()).toISOString(),state:'verified-exited'};
    this.violations.push(entry);this.violations=this.violations.slice(-100);
    result.verifiedExits++;this.audit('session_scope_exited',{id:s.id,createdAt:s.createdAt});
   }
   const recent=this.violations.filter(e=>this.now()-Date.parse(e.at)<10*60*1000);
   if(recent.length>=2&&!result.paused){
    this.pauseDispatch();
    const p=await this.getSession(original.value.primaryId),root=p?.session||p;
    if(root?.projectId===this.projectId&&!root.isTerminated&&root.activity?.state!=='exited'){
     const stop=await this.exitAgent(root.id);
     if(stop?.ok!==true)throw Error('Repeated unauthorized spawning and primary exit is unconfirmed');
     this.audit('session_scope_primary_parked',{id:root.id,violations:recent.length});
    }
    result.paused=true;this.audit('session_scope_escalated',{violations:recent.length});
   }
   this.last=result;return this.status();
  }catch(e){
   const error=String(e.message||e).slice(0,200);
   this.last={...this.last,checkedAt:new Date(this.now()).toISOString(),error};
   try{this.audit('session_scope_error',{error});}catch{}
   return this.status();
  }finally{this.inFlight=false;}
 }
 start(intervalMs=5000){
  if(this.timer)return;
  if(!Number.isInteger(intervalMs)||intervalMs<1000||intervalMs>60000)throw Error('Invalid governor interval');
  this.timer=setInterval(()=>{this.check().catch(()=>{});},intervalMs);
  this.timer.unref?.();
  this.check().catch(()=>{});
 }
 stop(){if(this.timer){clearInterval(this.timer);this.timer=null;}}
}
module.exports={SessionGovernor};
