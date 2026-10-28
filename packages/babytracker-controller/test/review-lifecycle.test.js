'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {FleetController}=require('../controller');
const {PROJECT,SOURCE_REPO,ISSUE_REPO}=require('../config');
const {verifyReview}=require('../review-evidence');
const {createServer}=require('../server');

function fixture(t){
  const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'baby-review-'));t.after(()=>fs.rmSync(stateDir,{recursive:true,force:true}));
  const commands=[];const config={projectId:PROJECT,sourceRepository:SOURCE_REPO,issueRepository:ISSUE_REPO,stateDir,runtimeVerified:true};
  const controller=new FleetController(config,{adapter:{sessions:async()=>[],command:async(...args)=>commands.push(args)},quota:()=>({fresh:true,remainingPercent:80}),
    reviewVerifier:async(task,request)=>({repository:SOURCE_REPO,prNumber:request.prNumber,headSha:request.headSha,reviewId:request.reviewId,decision:request.decision,reviewer:'independent',reviewedAt:'2026-10-28T00:00:00Z'}),
    resources:()=>({freeMemoryGiB:12})});
  const task={id:'task-1',issue:47,title:'Example',files:['docs/example.md'],status:'submitted',agentId:'babytracker-5',acceptance:'NOT_ASSESSED'};
  controller.state.tasks.push(task);controller.save();
  return {controller,commands,task,config};
}
function request(decision,revision){return {confirm:'ASSESS BabyTracker',decision,prNumber:47+revision,reviewId:100+revision,headSha:String(revision).repeat(40)};}
test('verified assessment persists and never commands any session',async t=>{
  const f=fixture(t);const result=await f.controller.assessTask('task-1',request('accepted',1));
  assert.equal(result.reviewRevision,1);assert.equal(f.task.status,'accepted');assert.equal(f.task.acceptance,'ACCEPTED');
  assert.equal(f.commands.length,0);
  const restored=JSON.parse(fs.readFileSync(path.join(f.config.stateDir,'controller.json'),'utf8'));
  assert.equal(restored.tasks[0].reviewReceipts[0].headSha,'1'.repeat(40));
  await assert.rejects(f.controller.assessTask('task-1',request('accepted',1)),/submitted/);
});
test('revision request requeues explicitly and final review cannot request another loop',async t=>{
  const f=fixture(t);
  await f.controller.assessTask('task-1',request('revision_requested',1));
  assert.equal(f.task.status,'proposed');assert.equal(f.task.agentId,null);assert.equal(f.commands.length,0);
  f.task.status='submitted';await f.controller.assessTask('task-1',request('revision_requested',2));
  f.task.status='submitted';await assert.rejects(f.controller.assessTask('task-1',request('revision_requested',3)),/Final review/);
  await f.controller.assessTask('task-1',request('rejected',3));
  assert.equal(f.task.status,'rejected');assert.equal(f.task.reviewReceipts.length,3);
});
test('duplicate evidence, absent task and wrong confirmation fail closed',async t=>{
  const f=fixture(t);
  await assert.rejects(f.controller.assessTask('task-1',{...request('accepted',1),confirm:'wrong'}),/confirmation/);
  await assert.rejects(f.controller.assessTask('unknown',request('accepted',1)),/submitted/);
  await f.controller.assessTask('task-1',request('revision_requested',1));f.task.status='submitted';
  await assert.rejects(f.controller.assessTask('task-1',{...request('accepted',2),headSha:'1'.repeat(40)}),/repeated/);
  assert.equal(f.task.reviewReceipts.length,1);assert.equal(f.commands.length,0);
});
test('GitHub verification binds requirement, revision, independent review and merge state',async()=>{
  const task={issue:47,files:['docs/example.md']};const pr={number:48,base:{repo:{full_name:SOURCE_REPO}},head:{sha:'a'.repeat(40)},body:'Closes MulattoTech/BabyTracker#47',user:{login:'author'},merged_at:'2026-10-28T00:00:00Z'};
  const reviews=[{id:101,commit_id:'a'.repeat(40),user:{login:'reviewer'},author_association:'MEMBER',submitted_at:'2026-10-28T00:01:00Z',state:'APPROVED'}];
  const files=[{filename:'docs/example.md'}];
  const read=async url=>url.includes('/reviews?')?reviews:url.includes('/files?')?files:pr;
  const receipt=await verifyReview(task,{prNumber:48,reviewId:101,decision:'accepted'},{read});
  assert.equal(receipt.headSha,'a'.repeat(40));
  await assert.rejects(verifyReview({...task,issue:4},{prNumber:48,reviewId:101,decision:'accepted'},{read}),/exact/);
  await assert.rejects(verifyReview(task,{prNumber:48,reviewId:101,decision:'accepted'},{read:async url=>url.includes('/files?')?[{filename:'src/unowned.js'}]:read(url)}),/file scope/);
  await assert.rejects(verifyReview(task,{prNumber:48,reviewId:101,decision:'accepted'},{read:async url=>url.includes('/reviews?')?[{...reviews[0],user:{login:'author'}}]:read(url)}),/Independent/);
  await assert.rejects(verifyReview(task,{prNumber:48,reviewId:101,decision:'accepted'},{read:async url=>url.includes('/reviews?')?[{...reviews[0],author_association:'NONE'}]:read(url)}),/authorized/);
  await assert.rejects(verifyReview(task,{prNumber:48,reviewId:101,decision:'accepted'},{read:async url=>url.includes('/reviews?')?[{...reviews[0],commit_id:'b'.repeat(40)}]:read(url)}),/Independent/);
  await assert.rejects(verifyReview(task,{prNumber:48,reviewId:101,decision:'accepted'},{read:async url=>url.includes('/reviews?')?reviews:url.includes('/files?')?files:{...pr,merged_at:null}}),/approved, merged/);
  await assert.rejects(verifyReview(task,{prNumber:48,reviewId:101,decision:'accepted'},{read:async url=>url.includes('/reviews?')?[...reviews,{...reviews[0],id:102,state:'CHANGES_REQUESTED',submitted_at:'2026-10-28T00:02:00Z'}]:read(url)}),/later change request/);
});
test('assessment HTTP action requires same origin and local token',async t=>{
  const f=fixture(t),server=createServer({config:{projectId:PROJECT},controller:f.controller});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const base='http://127.0.0.1:'+server.address().port;
  const token=(await (await fetch(base+'/api/session')).json()).token;
  const body=JSON.stringify({action:'assess-task',taskId:'task-1',...request('accepted',1)});
  const send=(origin,credential)=>fetch(base+'/api/action',{method:'POST',headers:{origin,'content-type':'application/json','x-babytracker-fleet':credential},body});
  assert.equal((await send('https://other.example',token)).status,403);
  assert.equal((await send(base,'wrong')).status,403);
  assert.equal(f.task.acceptance,'NOT_ASSESSED');
  assert.equal((await send(base,token)).status,200);
  assert.equal(f.task.acceptance,'ACCEPTED');assert.equal(f.commands.length,0);
});
