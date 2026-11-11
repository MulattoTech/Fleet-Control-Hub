'use strict';
// Read local canonical acceptance evidence without a Mission Control HTTP server.
// Never infer PASS from GitHub activity, task ledgers, or Fleet runtime state.
const fs=require('node:fs'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const DEFAULT_ROOT='C:\\Tools\\Dev\\MJobs';
const STATES=new Set(['PASS','PARTIAL','NOT_RUN']);
function jsonFile(root,name,maxSize){
  const file=path.join(root,name),stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size<2||stat.size>maxSize)throw Error('Canonical evidence is unavailable');
  return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
}
function tally(rows){
  const counts={PASS:0,PARTIAL:0,NOT_RUN:0};
  for(const item of rows){
    const state=item?.result;
    if(!STATES.has(state))throw Error('Unexpected acceptance status');
    counts[state]++;
  }
  return {pass:counts.PASS,partial:counts.PARTIAL,not_run:counts.NOT_RUN,total:rows.length};
}
function subgroup(rows,field){
  const groups=new Map();
  for(const item of rows){
    const name=item?.[field];
    if(typeof name!=='string'||!name||name.length>80)throw Error('Invalid acceptance group');
    if(!groups.has(name))groups.set(name,[]);
    groups.get(name).push(item);
  }
  return [...groups].map(([name,items])=>({name,...tally(items)}));
}
function gitValue(root,...args){
  try {
    const value=execFileSync('git',args,{cwd:root,encoding:'utf8',timeout:2000,windowsHide:true,stdio:['ignore','pipe','ignore'],maxBuffer:2000}).trim();
    return value.length<=160?value:null;
  }catch{return null;}
}
function matches(card,original,reference,cap,refs){
  const fields=['pass','partial','not_run','total'];
  return card?.schema_version===1&&
    card.original?.as_of===cap.timestamp&&card.reference?.as_of===refs.generated_at&&
    fields.every(k=>card.original[k]===original[k]&&card.reference[k]===reference[k]);
}
function readCanonicalProgress({root=process.env.MJOBS_ACCEPTANCE_ROOT||DEFAULT_ROOT,git=gitValue}={}){
  const cap=jsonFile(root,'planning/CAPABILITY_MATRIX.json',3_000_000);
  const refs=jsonFile(root,'planning/REFERENCE_GAP_MATRIX.json',1_000_000);
  if(cap?.schema_version!==1||!Array.isArray(cap.requirements)||cap.requirements.length<1||
     cap.requirements.length>10000||typeof cap.timestamp!=='string')throw Error('Canonical requirement matrix changed');
  const seen=new Set();
  for(const req of cap.requirements){
    if(!/^MJ-REQ-\d{3}(?:\.[A-Z][0-9]{2})?$/.test(req?.requirement_id)||seen.has(req.requirement_id))throw Error('Duplicate or invalid requirement');
    seen.add(req.requirement_id);
  }
  if(refs?.schema_version!==3||!Array.isArray(refs.canonical_ids)||
     !refs.result_by_id||typeof refs.result_by_id!=='object'||Array.isArray(refs.result_by_id)||
     refs.canonical_ids.length>10000||refs.canonical_ids.length===0||
     Object.keys(refs.result_by_id).length!==refs.canonical_ids.length)throw Error('Canonical reference matrix changed');
  const refSeen=new Set(),refRows=[];
  for(const id of refs.canonical_ids){
    if(!/^MJ-REF-\d{3}$/.test(id)||refSeen.has(id)||!Object.hasOwn(refs.result_by_id,id))throw Error('Duplicate or invalid reference gap');
    refSeen.add(id);refRows.push(refs.result_by_id[id]);
  }
  const original=tally(cap.requirements),reference=tally(refRows);
  let card=null;
  try{card=jsonFile(root,'docs/PROGRESS_CARD.json',100_000);}catch{}
  const cardMatches=matches(card,original,reference,cap,refs);
  const gitLocal=git(root,'rev-parse','refs/heads/main');
  const gitHead=git(root,'rev-parse','HEAD');
  return {available:true,observed_at:new Date().toISOString(),
    original,reference,original_as_of:cap.timestamp,reference_as_of:refs.generated_at,
    release_readiness:cardMatches?String(card.release_readiness||'UNKNOWN'):'UNKNOWN',
    // The card matching counts is not sufficient proof that every published dashboard artifact is current.
    checkpoint_current:false,
    areas:subgroup(cap.requirements,'area'),priorities:subgroup(cap.requirements,'priority'),
    git:{local_main_sha:gitLocal,checkout_head_sha:gitHead,checkout_branch:git(root,'branch','--show-current'),github_main_sha:null},
    source:'Local canonical MJobs matrices (no Mission Control dependency)',
    card_counts_match_matrices:cardMatches};
}
module.exports={readCanonicalProgress,tally,matches};
