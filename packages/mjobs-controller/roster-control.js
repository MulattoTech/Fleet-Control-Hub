'use strict';
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const DEFAULT=require('./roster-default.json');
const models={astra:'gpt-6-astra',sol:'gpt-6-sol',luna:'gpt-6-luna'};
function validate(value){
 if(!value||value.projectId!=='mjobs'||value.schemaVersion!==1||value.orchestrator?.count!==1||value.orchestrator.model!=='gpt-6-astra'||value.orchestrator.effort!=='xhigh')throw Error('One Astra High primary required');
 if(!Array.isArray(value.workerGroups)||value.workerGroups.length!==3)throw Error('Three model groups required');
 const seen=new Set();let total=1;
 for(const g of value.workerGroups){
  if(!Object.hasOwn(models,g.key)||models[g.key]!==g.model||seen.has(g.key)||g.effort!==(g.key==='luna'?'high':'medium')||!Number.isInteger(g.desired)||g.desired<0||g.desired>39)throw Error('Invalid worker group');
  seen.add(g.key);total+=g.desired;
 }
 const s=value.safety,d=value.dispatch;
 if(total>40||!s||!Number.isInteger(s.maxTotalSessions)||s.maxTotalSessions<total||s.maxTotalSessions>40||
  !Number.isFinite(s.maxCpuPercent)||s.maxCpuPercent>85||s.maxCpuPercent<1||!Number.isFinite(s.minFreeRamGiB)||s.minFreeRamGiB<12||
  !Number.isFinite(s.minFreeDiskGiB)||s.minFreeDiskGiB<80||!Number.isFinite(s.minProviderRemainingPercent)||s.minProviderRemainingPercent<1||s.minProviderRemainingPercent>99||
  !d||!Number.isInteger(d.targetWorking)||d.targetWorking<1||d.targetWorking>40)throw Error('Unsafe MJobs roster limits');
 return value;
}
class RosterControl{
 constructor(root){this.file=path.join(root,'Fleet-Roster-Profile.json');}
 read(){
  try{return validate(JSON.parse(fs.readFileSync(this.file,'utf8').replace(/^\uFEFF/,'')));}
  catch(e){if(e.code==='ENOENT')return validate(structuredClone(DEFAULT));throw Error('Roster configuration unavailable or invalid: '+e.message);}
 }
 next(sessions){
  const profile=this.read();
  // Replaced and unknown-model sessions consume capacity until terminated.
  const current=sessions.filter(s=>(s.projectId===undefined||s.projectId==='mjobs')&&!s.isTerminated);
  if(current.length>=profile.safety.maxTotalSessions)return {profile,current:current.length,group:null};
  const group=profile.workerGroups.find(g=>current.filter(s=>s.kind==='worker'&&s.model===g.model).length<g.desired)||null;
  return {profile,current:current.length,group:group?{...group,index:current.filter(s=>s.kind==='worker'&&s.model===group.model).length+1}:null};
 }
 update(changes){
  if(!changes||typeof changes!=='object'||Array.isArray(changes)||Object.keys(changes).some(k=>!['astra','sol','luna','targetWorking'].includes(k)))throw Error('Unexpected roster setting');
  let lock;
  try{
   lock=fs.openSync(this.file+'.lock','wx');const next=this.read();
   for(const g of next.workerGroups)if(Object.hasOwn(changes,g.key))g.desired=changes[g.key];
   if(Object.hasOwn(changes,'targetWorking'))next.dispatch.targetWorking=changes.targetWorking;
   next.safety.maxTotalSessions=1+next.workerGroups.reduce((sum,g)=>sum+g.desired,0);validate(next);
   const tmp=this.file+'.'+randomUUID()+'.tmp';
   try{fs.writeFileSync(tmp,JSON.stringify(next,null,2),{flag:'wx'});fs.renameSync(tmp,this.file);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
   return next;
  }finally{if(lock!==undefined){fs.closeSync(lock);fs.unlinkSync(this.file+'.lock');}}
 }
}
module.exports={RosterControl,validate};
