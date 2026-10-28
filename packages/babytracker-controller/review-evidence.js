'use strict';
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const run=promisify(execFile);
const repo='MulattoTech/BabyTracker';
async function github(path){
  const result=await run('gh.exe',['api',path],{windowsHide:true,timeout:15000,maxBuffer:1_000_000});
  return JSON.parse(result.stdout);
}
function validNumber(value){return Number.isSafeInteger(value)&&value>0;}
async function verifyReview(task,request,{read=github}={}){
  if(!validNumber(request?.prNumber)||!validNumber(request?.reviewId))throw Error('PR number and review ID required');
  if(!['accepted','revision_requested','rejected'].includes(request.decision))throw Error('Invalid review decision');
  const pr=await read('repos/'+repo+'/pulls/'+request.prNumber);
  if(pr?.number!==request.prNumber||pr?.base?.repo?.full_name!==repo||!/^[a-f0-9]{40}$/.test(pr?.head?.sha||''))throw Error('PR identity or revision could not be verified');
  if(typeof pr.body!=='string'||!RegExp('(?:^|\\W)MulattoTech/BabyTracker#'+task.issue+'(?!\\d)').test(pr.body))throw Error('PR does not cite the exact BabyTracker requirement');
  const files=await read('repos/'+repo+'/pulls/'+request.prNumber+'/files?per_page=100');
  if(!Array.isArray(files)||files.length===0||files.length>=100||!Array.isArray(task.files)||!task.files.length||
    files.some(f=>typeof f.filename!=='string'||!task.files.some(scope=>f.filename===scope||f.filename.startsWith(scope+'/'))))throw Error('PR file scope is outside the assigned task or incomplete');
  const reviews=await read('repos/'+repo+'/pulls/'+request.prNumber+'/reviews?per_page=100');
  if(!Array.isArray(reviews)||reviews.length>=100)throw Error('Review listing is unavailable or incomplete');
  const review=reviews.find(r=>r.id===request.reviewId);
  if(!review||review.commit_id!==pr.head.sha||!review.user?.login||review.user.login===pr.user?.login||!review.submitted_at||!['OWNER','MEMBER','COLLABORATOR'].includes(review.author_association))throw Error('Independent authorized review of current PR revision is unverified');
  if(reviews.some(r=>r.commit_id===pr.head.sha&&r.submitted_at>review.submitted_at&&r.state==='CHANGES_REQUESTED'))throw Error('A later change request supersedes this review');
  if(request.decision==='accepted'&&(review.state!=='APPROVED'||!pr.merged_at))throw Error('Acceptance requires an approved, merged PR');
  if(request.decision!=='accepted'&&(review.state!=='CHANGES_REQUESTED'||pr.merged_at))throw Error('Revision or rejection requires an unmerged change request');
  return {repository:repo,prNumber:request.prNumber,headSha:pr.head.sha,reviewId:review.id,reviewer:review.user.login,reviewedAt:review.submitted_at,decision:request.decision};
}
module.exports={verifyReview};
