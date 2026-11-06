'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {IssueQueue}=require('./issue-queue');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'mjobs-issues-'));
try {
 const queue=new IssueQueue(tmp);
 const issues=[{number:525,title:'[Security] Audit recovery bundle',state:'OPEN',assignees:[],labels:[{name:'priority:P1'}]},
  {number:919,title:'Recently Viewed',state:'OPEN',assignees:[],labels:[{name:'priority:P2'}]},
  {number:270,title:'Document Fact Trace',state:'OPEN',assignees:[],labels:[{name:'priority:P1'}]},
  {number:903,title:'[MJ-TH-RECON] Parent',state:'OPEN',assignees:[],labels:[{name:'priority:P1'}]},
  {number:466,title:'Analytics',state:'CLOSED',assignees:[],labels:[{name:'priority:P1'}]}];
 const workers=[{id:'mjobs-7',kind:'worker',activity:'idle',isIdle:true,openPRs:0},
  {id:'mjobs-8',kind:'worker',activity:'idle',isIdle:true,openPRs:0},
  {id:'mjobs-9',kind:'worker',activity:'active',openPRs:0},
  {id:'mjobs-10',kind:'worker',activity:'idle',openPRs:1}];
 let plan=queue.available(issues,workers,[]);
 assert.deepEqual(plan.map(x=>[x.agentId,x.issue.number]),[['mjobs-7',270],['mjobs-8',525]]);
 assert.equal(queue.reserve(270,'mjobs-7'),true);
 assert.equal(queue.reserve(270,'mjobs-8'),false);
 assert.equal(queue.reserve(525,'mjobs-7'),false);
 queue.mark(270,'submitted');
 assert.equal(new IssueQueue(tmp).load().claims[270].agentId,'mjobs-7');
 plan=queue.available(issues,workers,[]);
 assert.deepEqual(plan.map(x=>[x.agentId,x.issue.number]),[['mjobs-8',525]]);
 assert.equal(queue.reserve(525,'mjobs-8'),true);
 queue.mark(525,'uncertain');
 assert.equal(queue.available(issues,workers,[]).length,0);
 // Unlabeled, P2/P6, broad bookkeeping and conflicting labels are never
 // promoted to active worker assignments, even when older numbers sort first.
 const higher=new IssueQueue(path.join(tmp,'priority-test'));
 fs.mkdirSync(path.join(tmp,'priority-test'));
 const candidates=higher.candidates([
  {number:317,title:'Future board adapter',state:'OPEN',assignees:[],labels:[{name:'priority:P6'}]},
  {number:318,title:'ATS adapter',state:'OPEN',assignees:[],labels:[{name:'priority:P2'}]},
  {number:919,title:'Recently viewed',state:'OPEN',assignees:[],labels:[{name:'priority:P2'}]},
  {number:294,title:'Global definition',state:'OPEN',assignees:[],labels:[{name:'priority:P0'},{name:'category:bookkeeping'}]},
  {number:3,title:'No label evidence',state:'OPEN',assignees:[]},
  {number:18,title:'Conflicting priority',state:'OPEN',assignees:[],labels:[{name:'priority:P0'},{name:'priority:P1'}]},
  {number:270,title:'Fact trace',state:'OPEN',assignees:[],labels:[{name:'priority:P1'}]},
  {number:5,title:'Critical operation guard',state:'OPEN',assignees:[],labels:[{name:'priority:P0'}]}
 ],[],[]);
 assert.deepEqual(candidates.map(x=>x.number),[5,270],'P0 first; only explicit unowned coding P0/P1 eligible');
 assert.throws(()=>queue.reserve(-1,'mjobs-7'),/Invalid/);
 fs.writeFileSync(queue.file,'corrupt');
 assert.throws(()=>queue.available(issues,workers,[]),/unavailable/);
 console.log('PASS IssueQueue: unique assignments, claims after reboot, PR held and fail-closed invalid state');
} finally {fs.rmSync(tmp,{recursive:true,force:true});}
