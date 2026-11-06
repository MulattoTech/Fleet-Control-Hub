'use strict';

// A project registration is an explicit Fleet Control boundary, not a claim
// over every Codex process on the computer. Native AO session operations are
// the only mutations this module permits; executable names and process trees
// never establish membership.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {performance}=require('node:perf_hooks');

const SCOPE_FILE='fleet-codex-scope.json';
const ID=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MAX_ATTEMPTS=3,RETRY_MS=30000,MAX_STOPS=4;
const MAX_SWEEP_MS=20000,MAX_VERIFICATION_CALLS=64;
const IDENTITY_KEYS=['id','projectId','createdAt','harness','mode','terminalGeneration'];
const own=(object,key)=>Object.prototype.hasOwnProperty.call(object,key);

function validateScope(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||value.version!==1||
  Object.keys(value).some(key=>!['version','projectIds'].includes(key))||
  !Array.isArray(value.projectIds)||value.projectIds.length<1||value.projectIds.length>64||
  value.projectIds.some(id=>typeof id!=='string'||!ID.test(id))||
  new Set(value.projectIds.map(id=>id.toLowerCase())).size!==value.projectIds.length)
  throw Error('Fleet Codex scope is invalid; explicit unique project IDs are required');
 return {version:1,projectIds:[...value.projectIds]};
}
function readScope(root){
 const file=path.join(root,SCOPE_FILE),stat=fs.statSync(file);
 if(!stat.isFile()||stat.size>65536)throw Error('Fleet Codex scope file is invalid');
 return validateScope(JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')));
}
function ensureScope(root,projectId){
 if(typeof projectId!=='string'||!ID.test(projectId))throw Error('An explicit safe controller project ID is required');
 const file=path.join(root,SCOPE_FILE);
 try{fs.writeFileSync(file,JSON.stringify({version:1,projectIds:[projectId]},null,2)+'\n',{flag:'wx',mode:0o600});}
 catch(error){if(error.code!=='EEXIST')throw error;}
 const scope=readScope(root);
 if(!scope.projectIds.includes(projectId))throw Error('This controller project is not registered in the existing Fleet Codex scope');
 return scope;
}
function isoDate(value){
 if(typeof value!=='string')return false;
 const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
 if(!m||!Number.isFinite(Date.parse(value)))return false;
 const [,year,month,day,hour,minute,second,offsetHour='0',offsetMinute='0']=m.map((v,i)=>i?Number(v??0):v);
 return month>=1&&month<=12&&day>=1&&day<=new Date(Date.UTC(year,month,0)).getUTCDate()&&
  hour<=23&&minute<=59&&second<=59&&offsetHour<=23&&offsetMinute<=59;
}
function sessionIdentity(session){
 if(!session||typeof session!=='object'||Array.isArray(session)||
  typeof session.id!=='string'||!ID.test(session.id)||typeof session.projectId!=='string'||!ID.test(session.projectId)||
  session.harness!=='codex'||!['chat','tui'].includes(session.mode)||!isoDate(session.createdAt)||
  typeof session.isTerminated!=='boolean'||
  (session.terminalGeneration!=null&&(typeof session.terminalGeneration!=='string'||session.terminalGeneration.length>256||session.terminalGeneration.includes('\0'))))return null;
 return {id:session.id,projectId:session.projectId,createdAt:session.createdAt,harness:'codex',mode:session.mode,
  terminalGeneration:session.terminalGeneration??null};
}
function sameIdentity(a,b){
 if(!a||!b||typeof a!=='object'||typeof b!=='object')return false;
 const left=sessionIdentity({...a,isTerminated:false}),right=sessionIdentity({...b,isTerminated:false});
 return !!left&&!!right&&IDENTITY_KEYS.every(key=>left[key]===right[key]);
}
function fingerprint(identity){return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');}
function inventory(rows,scope){
 if(!Array.isArray(rows)||rows.length>10000)throw Error('AO session inventory is unavailable or invalid');
 const byId=new Map(),folded=new Set(),targets=[];
 for(const session of rows){
  if(!session||typeof session!=='object'||Array.isArray(session)||typeof session.id!=='string'||!ID.test(session.id)||
   typeof session.projectId!=='string'||!ID.test(session.projectId)||typeof session.harness!=='string')
   throw Error('AO session membership is ambiguous');
  const key=session.id.toLowerCase();
  if(folded.has(key))throw Error('AO session inventory contains duplicate or ambiguous IDs');
  folded.add(key);byId.set(session.id,session);
  if(!scope.projectIds.includes(session.projectId)||session.harness!=='codex')continue;
  const identity=sessionIdentity(session);
  if(!identity)throw Error('A registered fleet Codex session has incomplete identity');
  targets.push({session,identity,fingerprint:fingerprint(identity)});
 }
 return {byId,targets,active:targets.filter(target=>!target.session.isTerminated)};
}
function attemptFor(attempts,target){
 const record=attempts instanceof Map?attempts.get(target.identity.id):own(attempts,target.identity.id)?attempts[target.identity.id]:null;
 if(!record||record.fingerprint!==target.fingerprint)return {fingerprint:target.fingerprint,count:0,lastAttempt:0,inspectedAt:0};
 if(!Number.isSafeInteger(record.count)||record.count<0||!Number.isFinite(record.lastAttempt)||record.lastAttempt<0||
  own(record,'inspectedAt')&&(!Number.isFinite(record.inspectedAt)||record.inspectedAt<0))
  throw Error('Fleet stop attempt ledger is invalid for '+target.identity.id);
 return {fingerprint:record.fingerprint,count:record.count,lastAttempt:record.lastAttempt,inspectedAt:record.inspectedAt??0};
}
function saveAttempt(attempts,id,value){
 if(attempts instanceof Map)attempts.set(id,value);
 else Object.defineProperty(attempts,id,{value,writable:true,enumerable:true,configurable:true});
}

/**
 * stopSession receives one fresh raw AO DTO; its return value is NOT stop proof.
 * verifyStopped receives a raw DTO and must return exactly true only for native
 * runtime evidence bound to that identity. False is an unresolved current
 * target; an exception makes the final count unknown. attempts is mutated before
 * stopSession so a runner can persist that reservation before native submission.
 * Callbacks also receive {signal, deadlineAt, remainingMs}; deadlineAt uses the
 * monotonic elapsedNow clock, not a wall-clock date. Native adapters must honor
 * signal and recheck the budget immediately before submission. No callback is
 * started after deadline; an already-submitted outcome stays uncertain.
 */
async function sweepFleetCodex({scope,readSessions,stopSession,verifyStopped,isLatched,now=Date.now,attempts={},dryRun=false,maxStops=MAX_STOPS,
 maxSweepMs=MAX_SWEEP_MS,maxVerificationCalls=MAX_VERIFICATION_CALLS,elapsedNow=()=>performance.now()}={}){
 const errors=[],results=new Map();let scoped=null,unknown=false,latchReleased=false,submissions=0;
 const controller=new AbortController();let deadlineAt=null,verificationCalls=0,budgetExhausted=false,verificationExhausted=false;
 const report=(message)=>{errors.push(message);};
 const result=(target,fields)=>results.set(target.identity.id,{id:target.identity.id,projectId:target.identity.projectId,
  ...(results.get(target.identity.id)||{}),...fields});
 const finish=(remaining)=>{controller.abort();return {phase:remaining===0&&!unknown&&!latchReleased?'holding_zero':'partial_stop',
  remainingTotal:unknown||latchReleased?null:remaining,remaining:{codex:unknown||latchReleased?null:remaining},
  remainingUnit:'AO Codex sessions',results:[...results.values()],errorCount:errors.length,recentErrors:errors.slice(-8),
  scope:'fleet-owned',projectIds:scoped?.projectIds||[],manualSessionsPreserved:true,orphanProcessesInspected:false,
  dryRun:dryRun===true,submissions,verificationCalls,budgetExhausted,verificationExhausted,
  notes:'Only current Codex sessions in explicitly registered Fleet Control projects are targeted. Standalone Codex and unregistered projects are untouched; orphan OS process absence is not claimed.'};};
 const clock=()=>{const value=typeof now==='function'?now():now;if(!Number.isFinite(value)||value<0)throw Error('Fleet stop clock is unavailable');return value;};
 const remainingMs=()=>{const value=elapsedNow();return Number.isFinite(value)&&Number.isFinite(deadlineAt)?Math.max(0,Math.min(maxSweepMs,deadlineAt-value)):0;};
 const context={signal:controller.signal,get deadlineAt(){return deadlineAt;},remainingMs};
 const exhausted=()=>{
  if(!budgetExhausted)report('Fleet stop sweep reached its elapsed-time budget; unverified targets remain unknown');
  budgetExhausted=true;unknown=true;controller.abort();return Error('Fleet stop sweep deadline reached');
 };
 const bounded=async callback=>{
  const time=remainingMs();if(controller.signal.aborted||time<=0)throw exhausted();
  return new Promise((resolve,reject)=>{
   let done=false;
   const settle=(fn,value)=>{if(done)return;done=true;clearTimeout(timer);fn(value);};
   const timer=setTimeout(()=>settle(reject,exhausted()),time);
   Promise.resolve().then(()=>{
    if(controller.signal.aborted||remainingMs()<=0)throw exhausted();
    return callback(context);
   }).then(value=>settle(resolve,value),error=>settle(reject,error));
  });
 };
 const latched=async()=>{
  try{if(await bounded(ctx=>isLatched(ctx))===true)return true;}catch{if(!budgetExhausted)report('Fleet latch state is unavailable');unknown=true;return false;}
  latchReleased=true;report('Fleet latch was released; no further stop was submitted');return false;
 };
 const read=async()=>inventory(await bounded(ctx=>readSessions(ctx)),scoped);
 const verify=async(session,onBegin)=>{
  if(!await latched())return {stopped:false,unavailable:true,halt:true};
  if(verificationCalls>=maxVerificationCalls){
   if(!verificationExhausted)report('Fleet native-proof budget reached; unverified targets remain unknown');
   verificationExhausted=true;unknown=true;return {stopped:false,unavailable:true,halt:true};
  }
  verificationCalls++;
  onBegin?.();
  try{return {stopped:await bounded(ctx=>verifyStopped(session,ctx))===true,unavailable:false};}
  catch{return {stopped:false,unavailable:true};}
 };
 let initial;
 try{
  scoped=validateScope(scope);
  if(typeof readSessions!=='function'||typeof stopSession!=='function'||typeof verifyStopped!=='function'||typeof isLatched!=='function'||
   !(attempts instanceof Map)&&(attempts===null||typeof attempts!=='object'||Array.isArray(attempts))||
   !Number.isInteger(maxStops)||maxStops<0||maxStops>MAX_STOPS||typeof elapsedNow!=='function'||
   !Number.isInteger(maxSweepMs)||maxSweepMs<1||maxSweepMs>MAX_SWEEP_MS||
   !Number.isInteger(maxVerificationCalls)||maxVerificationCalls<1||maxVerificationCalls>MAX_VERIFICATION_CALLS)
   throw Error('Fleet stop callbacks, ledger or submission bound are invalid');
  const startedAt=elapsedNow();if(!Number.isFinite(startedAt))throw Error('Sweep clock is unavailable');deadlineAt=startedAt+maxSweepMs;
  clock();
  if(!await latched())return finish(null);
  initial=await read();
 }catch{unknown=true;report('Fleet scope or AO session inventory is unavailable or ambiguous; no stop was submitted');return finish(null);}
 for(const target of initial.targets.filter(value=>value.session.isTerminated))result(target,{status:'archived_excluded',verifiedStopped:false});
 let candidates;
 try{
  candidates=initial.active.map(target=>({...target,attempt:attemptFor(attempts,target)}))
   .sort((a,b)=>a.attempt.inspectedAt-b.attempt.inspectedAt||a.attempt.count-b.attempt.count||
    a.attempt.lastAttempt-b.attempt.lastAttempt||a.identity.id.localeCompare(b.identity.id));
 }catch{unknown=true;report('Fleet stop attempt ledger is invalid; no stop was submitted');return finish(null);}
 for(const target of candidates){
  if(!await latched())break;
  // Once the native-submission batch is full, leave further work for the next
  // sweep rather than spending an unbounded pre-action probe per deferred row.
  if(!dryRun&&submissions>=maxStops){result(target,{status:'deferred_batch',verifiedStopped:false});continue;}
  // Persist fair inspection progress separately from actual native attempts.
  // Otherwise a large prefix of already-stopped sessions can consume every
  // bounded sweep and permanently hide later live sessions or their retries.
  // Final-only proofs do not advance this cursor: those rows have not yet had
  // a chance to receive an action in the candidate pass.
  const proof=await verify(target.session,()=>{
   if(dryRun)return;
   target.attempt={...target.attempt,inspectedAt:clock()};
   saveAttempt(attempts,target.identity.id,target.attempt);
  });
  if(proof.halt||budgetExhausted)break;
  if(proof.stopped){result(target,{status:'verified_stopped',verifiedStopped:true});continue;}
  if(dryRun){result(target,{status:'would_stop',verifiedStopped:false});continue;}
  if(target.attempt.count>=MAX_ATTEMPTS){result(target,{status:'attempt_limit',verifiedStopped:false,attempts:target.attempt.count});continue;}
  if(target.attempt.count>0&&clock()-target.attempt.lastAttempt<RETRY_MS){result(target,{status:'retry_cooldown',verifiedStopped:false});continue;}
  let before,current;
  try{before=await read();current=before.byId.get(target.identity.id);}
  catch{unknown=true;report('AO membership recheck failed before '+target.identity.id);result(target,{status:'membership_unavailable',verifiedStopped:false});break;}
  if(!sameIdentity(target.identity,sessionIdentity(current))){
   unknown=true;report('Native session identity changed before '+target.identity.id);result(target,{status:'identity_changed',verifiedStopped:false});continue;
  }
  if(current.isTerminated){result(target,{status:'archived_excluded',verifiedStopped:false});continue;}
  const currentProof=await verify(current);
  if(currentProof.halt||budgetExhausted)break;
  if(currentProof.stopped){result(target,{status:'verified_stopped',verifiedStopped:true});continue;}
  if(!await latched())break;
  const reservation={fingerprint:target.fingerprint,count:target.attempt.count+1,lastAttempt:clock(),inspectedAt:target.attempt.inspectedAt};
  saveAttempt(attempts,target.identity.id,reservation);submissions++;
  result(target,{status:'stop_submitted',attempts:reservation.count,verifiedStopped:false});
  try{await bounded(ctx=>stopSession(current,ctx));}
  catch{report('Native stop outcome is uncertain for '+target.identity.id);result(target,{status:'stop_uncertain',verifiedStopped:false});}
  // Native submission may have succeeded despite a timeout. Observe before
  // any later sweep can retry; never replay within this sweep.
  let after;
  try{after=(await read()).byId.get(target.identity.id);}
  catch{unknown=true;report('AO membership recheck failed after '+target.identity.id);result(target,{status:'stop_unverified',verifiedStopped:false});break;}
  if(!sameIdentity(target.identity,sessionIdentity(after))){
   unknown=true;report('Native session identity changed after '+target.identity.id);result(target,{status:'identity_changed',verifiedStopped:false});continue;
  }
  if(after.isTerminated){result(target,{status:'archived_excluded',verifiedStopped:false});continue;}
  const afterProof=await verify(after);
  if(afterProof.stopped)result(target,{status:'verified_stopped',verifiedStopped:true});
  if(afterProof.halt||budgetExhausted)break;
 }
 let final;
 try{final=await read();}
 catch{unknown=true;report('Final AO session inventory is unavailable or ambiguous');return finish(null);}
 for(const target of initial.active){
  if(!sameIdentity(target.identity,sessionIdentity(final.byId.get(target.identity.id)))){
   unknown=true;report('Original fleet session identity is no longer verifiable: '+target.identity.id);
  }
 }
 let remaining=0;
 for(const target of final.targets.filter(value=>value.session.isTerminated))result(target,{status:'archived_excluded',verifiedStopped:false});
 for(const target of final.active){
  const proof=await verify(target.session);
  if(proof.halt||budgetExhausted){unknown=true;break;}
  if(proof.stopped){result(target,{status:'verified_stopped',verifiedStopped:true});continue;}
  remaining++;
  if(!results.has(target.identity.id))result(target,{status:'deferred_new_target',verifiedStopped:false});
  else result(target,{...(results.get(target.identity.id).status==='verified_stopped'?{status:'stop_unverified'}:{}),verifiedStopped:false});
  if(proof.unavailable){unknown=true;report('Native stop proof is unavailable for '+target.identity.id);}
 }
 await latched();
 return finish(remaining);
}

module.exports={SCOPE_FILE,MAX_ATTEMPTS,RETRY_MS,MAX_STOPS,MAX_SWEEP_MS,MAX_VERIFICATION_CALLS,validateScope,readScope,ensureScope,sessionIdentity,sameIdentity,sweepFleetCodex};
