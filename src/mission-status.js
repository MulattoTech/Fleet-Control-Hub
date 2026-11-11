'use strict';
// Local canonical matrices own acceptance accounting; no legacy HTTP dashboard
// is required. Never infer PASS from PRs, commits or controller activity.
const {readCanonicalProgress}=require('./canonical-acceptance');
const SHA=/^[a-f0-9]{40}$/;
function counts(input){
  if(!input||!['pass','partial','not_run','total'].every(k=>Number.isSafeInteger(input[k])&&input[k]>=0&&input[k]<=10000)||
     input.pass+input.partial+input.not_run>input.total)return null;
  return {pass:input.pass,partial:input.partial,notRun:input.not_run,total:input.total};
}
function breakdown(input,limit){
  if(!Array.isArray(input))return [];
  return input.slice(0,limit).flatMap(row=>{
    const result=counts(row),name=typeof row?.name==='string'?row.name.trim():'';
    return result&&name.length&&name.length<=80?[{name,...result}]:[];
  });
}
function project(raw){
  if(raw?.available!==true)return {available:false,reason:'Canonical MJobs acceptance evidence is unavailable.'};
  const original=counts(raw.original),reference=counts(raw.reference);
  if(!original||!reference)return {available:false,reason:'Canonical MJobs acceptance contract changed.'};
  const local=SHA.test(raw.git?.local_main_sha)?raw.git.local_main_sha:null;
  const checkout=SHA.test(raw.git?.checkout_head_sha)?raw.git.checkout_head_sha:null;
  const published=SHA.test(raw.git?.github_main_sha)?raw.git.github_main_sha:null;
  // Mission Control reads snapshot(root), i.e. the checked-out working tree,
  // not refs/heads/main. Main can match GitHub while that checkout differs.
  const synced=checkout&&published?checkout===published:null;
  const localMainSynced=local&&published?local===published:null;
  let warning=synced===false?'Checked-out MJobs source differs from GitHub main; local acceptance counts are not confirmed current.':
    synced===null?'Checkout or GitHub main SHA unavailable; local acceptance counts are not confirmed current.':
    'Checkout HEAD matches GitHub main; counts remain a live local working-tree snapshot, not verified published acceptance.';
  if(localMainSynced===false)warning+=' Local main also differs from GitHub main.';
  return {available:true,observedAt:typeof raw.observed_at==='string'?raw.observed_at:null,
    original,reference,priorities:breakdown(raw.priorities,12),areas:breakdown(raw.areas,40),
    releaseReadiness:String(raw.release_readiness||'UNKNOWN').slice(0,80),
    checkpointCurrent:raw.checkpoint_current===true,localMainSha:local,githubMainSha:published,
    checkoutHeadSha:checkout,checkoutBranch:typeof raw.git?.checkout_branch==='string'?raw.git.checkout_branch.slice(0,160):null,
    originalAsOf:typeof raw.original_as_of==='string'?raw.original_as_of.slice(0,160):null,
    referenceAsOf:typeof raw.reference_as_of==='string'?raw.reference_as_of.slice(0,160):null,
    githubSynced:synced,localMainSynced,publicationVerified:false,
    source:'Local canonical MJobs matrices (working-tree snapshot)',warning};
}
function createMissionStatus({reader=readCanonicalProgress,clock=Date.now,ttlMs=5000}={}){
  let last=0,snapshot={available:false,reason:'Canonical MJobs evidence has not been checked.'},pending;
  async function status(){
    if(pending)return pending;
    if(last&&clock()-last<ttlMs)return snapshot;
    pending=(async()=>{
      try{snapshot=project(await reader());}
      catch{snapshot={available:false,reason:'Local canonical MJobs matrices are unavailable or invalid.'};}
      last=clock();pending=null;return snapshot;
    })();return pending;
  }
  return {status};
}
module.exports={createMissionStatus,project,counts};
