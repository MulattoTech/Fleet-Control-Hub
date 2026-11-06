'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {RosterControl}=require('./roster-control');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'mjobs-roster-'));
const source=path.join(__dirname,'roster-default.json');
try{
 fs.copyFileSync(source,path.join(tmp,'Fleet-Roster-Profile.json'));
 const c=new RosterControl(tmp);
 const full=c.read();
 assert.equal(full.orchestrator.model,'gpt-6-astra');
 assert.equal(full.orchestrator.effort,'xhigh');
 assert.equal(full.workerGroups.reduce((sum,g)=>sum+g.desired,1),40);
 const sessions=[{id:'mjobs-1',projectId:'mjobs',kind:'orchestrator',model:'gpt-6-astra'}, ...Array.from({length:8},(_,i)=>({id:'mjobs-'+(i+2),projectId:'mjobs',kind:'worker',model:'gpt-6-astra'}))];
 const next=c.next(sessions);
 assert.equal(next.group.model,'gpt-6-astra');
 assert.equal(next.group.index,9);
 assert.equal(c.update({astra:8,sol:12,luna:15,targetWorking:22}).safety.maxTotalSessions,36);
 assert.equal(c.read().dispatch.targetWorking,22); assert.equal(c.read().workerGroups.find(g=>g.key==='luna').effort,'high');
 assert.throws(()=>c.update({astra:40,sol:40}),/exceeds|Invalid worker group/);
 assert.throws(()=>c.update({secret:'bad'}),/Unexpected/);
 assert.throws(()=>c.update({targetWorking:41}),/Invalid|Unsafe/);
 assert.equal(c.read().safety.maxTotalSessions,36,'Rejected edits leave disk intact');
 console.log('PASS RosterControl: 40-slot Astra/Sol/Luna, future edits, bounds and atomic validation');
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
