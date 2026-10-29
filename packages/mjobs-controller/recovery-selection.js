'use strict';
const fs=require('node:fs'),path=require('node:path');
function selectRecoverySnapshot(root,snapshot,projectId,{required=false}={}){
 if(projectId!=='mjobs-luna')return snapshot;
 let selection;
 try{selection=JSON.parse(fs.readFileSync(path.join(root,'startup-selection.json'),'utf8').replace(/^\uFEFF/,''));}
 catch(e){if(e.code==='ENOENT'&&!required)return snapshot;throw Error('MJobs startup selection is missing or unreadable; no sessions may be restored');}
 if(selection.version!==1||selection.projectId!==projectId||!Number.isInteger(selection.maxSessions)||selection.maxSessions<1||selection.maxSessions>32||
    !Array.isArray(selection.sessionIds)||!selection.sessionIds.length||selection.sessionIds.length>selection.maxSessions||
    new Set(selection.sessionIds).size!==selection.sessionIds.length||selection.sessionIds.some(id=>!/^mjobs-luna-[0-9]+$/.test(id))||
    !selection.sessionIds.includes(selection.primaryId))throw Error('MJobs startup selection exceeds its hard session limit or has invalid identities');
 const records=selection.sessionIds.map(id=>{
  const found=snapshot.sessions.filter(s=>s.id===id&&s.projectId===projectId);
  if(found.length!==1||found[0].isTerminated||!['active','working','idle','waiting_input','blocked'].includes(found[0].activity))throw Error('Selected MJobs session is missing, duplicated, or archived: '+id);
  return found[0];
 });
 const primaries=records.filter(s=>s.kind==='orchestrator');
 if(primaries.length!==1||primaries[0].id!==selection.primaryId)throw Error('MJobs startup selection must have one exact primary');
 return {...snapshot,sessions:snapshot.sessions.filter(s=>selection.sessionIds.includes(s.id))};
}
module.exports={selectRecoverySnapshot};
