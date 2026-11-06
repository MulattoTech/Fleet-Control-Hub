'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {IssueQueue}=require('./issue-queue');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'mjobs-issues-'));
try {
 const queue=new IssueQueue(tmp);
 const issues=[{number:525,title:'[Security] Audit recovery bundle',state:'OPEN',assignees:[]},
  {number:919,title:'Recently Viewed',state:'OPEN',assignees:[]},
  {number:903,title:'[MJ-TH-RECON] Parent',state:'OPEN',assignees:[]},
  {number:466,title:'Analytics',state:'CLOSED',assignees:[]}];
 const workers=[{id:'mjobs-7',kind:'worker',activity:'idle',isIdle:true,openPRs:0},
  {id:'mjobs-8',kind:'worker',activity:'idle',isIdle:true,openPRs:0},
  {id:'mjobs-9',kind:'worker',activity:'active',openPRs:0},
  {id:'mjobs-10',kind:'worker',activity:'idle',openPRs:1}];
 let plan=queue.available(issues,workers,[]);
 assert.deepEqual(plan.map(x=>[x.agentId,x.issue.number]),[['mjobs-7',525],['mjobs-8',919]]);
 assert.equal(queue.reserve(525,'mjobs-7'),true);
 assert.equal(queue.reserve(525,'mjobs-8'),false);
 assert.equal(queue.reserve(919,'mjobs-7'),false);
 queue.mark(525,'submitted');
 assert.equal(new IssueQueue(tmp).load().claims[525].agentId,'mjobs-7');
 plan=queue.available(issues,workers,[]);
 assert.deepEqual(plan.map(x=>[x.agentId,x.issue.number]),[['mjobs-8',919]]);
 assert.equal(queue.reserve(919,'mjobs-8'),true);
 queue.mark(919,'uncertain');
 assert.equal(queue.available(issues,workers,[]).length,0);
 assert.throws(()=>queue.reserve(-1,'mjobs-7'),/Invalid/);
 fs.writeFileSync(queue.file,'corrupt');
 assert.throws(()=>queue.available(issues,workers,[]),/unavailable/);
 console.log('PASS IssueQueue: unique assignments, claims after reboot, PR held and fail-closed invalid state');
} finally {fs.rmSync(tmp,{recursive:true,force:true});}
