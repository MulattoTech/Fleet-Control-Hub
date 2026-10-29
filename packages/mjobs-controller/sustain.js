'use strict';
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {randomUUID}=require('node:crypto');
const {ProductiveWork}=require('./productive-work');
const execAsync=promisify(execFile);
const GiB=1024**3;
const DEF=Object.freeze({
 enabled:false,
 intervalSeconds:60,
 minFreeRamGiB:9,
 minFreeDiskGiB:25,
 maxCpuPercent:92,
 targetWorking:12,
 maxDispatchPerTick:2,
 minQuietSeconds:180,
 repeatNoProgressBackoffMinutes:20,
 rootCooldownMinutes:10,
 resourceHeavyTestLanes:2,
 productiveWork:false,
 reserveWorkers:0
});
const parse=x=>{const v=Date.parse(x||'');return Number.isFinite(v)?v:0};
const clone=x=>JSON.parse(JSON.stringify(x));
const {publicError,publicState,privateDiagnostic,isUsageLimit}=require('./control-errors');
const {canReceiveInstruction}=require('./runtime-health');
const {prSignal,graphSignal,DispatchSignals,REPORT_POLICY}=require('./dispatch-policy');
const short=()=>publicError('sustain');
function atomic(p,x){const t=p+'.tmp';fs.writeFileSync(t,JSON.stringify(x,null,2),'utf8');fs.renameSync(t,p)}
function read(p,x){try{return JSON.parse(fs.readFileSync(p,'utf8'))}catch{return clone(x)}}
function ensureInt(v,min,max,k){if(!Number.isInteger(v)||v<min||v>max)throw Error(k+' must be an integer from '+min+' to '+max)}
function verifySettings(x){
 ensureInt(x.intervalSeconds,30,180,'intervalSeconds');
 ensureInt(x.minFreeRamGiB,6,32,'minFreeRamGiB');
 ensureInt(x.minFreeDiskGiB,10,120,'minFreeDiskGiB');
 ensureInt(x.maxCpuPercent,70,100,'maxCpuPercent');
 ensureInt(x.targetWorking,3,64,'targetWorking');
 ensureInt(x.reserveWorkers,0,8,'reserveWorkers');
 if(typeof x.productiveWork!=='boolean')throw Error('productiveWork must be boolean');
 ensureInt(x.maxDispatchPerTick,1,12,'maxDispatchPerTick');
 ensureInt(x.minQuietSeconds,60,1200,'minQuietSeconds');
 ensureInt(x.repeatNoProgressBackoffMinutes,5,120,'repeatNoProgressBackoffMinutes');
 ensureInt(x.rootCooldownMinutes,2,60,'rootCooldownMinutes');
 ensureInt(x.resourceHeavyTestLanes,1,5,'resourceHeavyTestLanes');
 return x;
}
const denyTaskWords=/\b(apply to actual jobs|real employer submission|force push|force-push|delete production|credentials|password)\b/i;
class Sustain {
 constructor({root,getState,turbo,command,audit,isManualBusy=()=>false,clock=()=>Date.now(),
  issueRunner=null,autoSchedule=true}){
  this.root=root;this.getState=getState;this.turbo=turbo;this.signals=new DispatchSignals(root);this.productivity=new ProductiveWork(root);this.artifactReviews=new (require('./artifact-review').ArtifactReviews)(root);
  this.command=command;this.audit=audit;this.isManualBusy=isManualBusy;this.clock=clock;
  this.configPath=path.join(root,'sustain-config.json');
  this.statePath=path.join(root,'sustain-state.json');
  this.eventsPath=path.join(root,'sustain-events.jsonl');
  this.taskPath=path.join(root,'sustain-task-bank.json');
  this.config=verifySettings({...DEF,...read(this.configPath,{})});
  this.status=read(this.statePath,{agents:{},leases:{},reviewHeads:{},ticks:0,lastTick:null,lastSuccess:null,lastError:null,quotaPausedUntil:null,sentTotal:0,dispatches:[]});
   this.status.agents||={};this.status.leases||={};this.status.reviewHeads||={};this.status.dispatches||=[];this.status.workItems||={};
  this.taskBank=read(this.taskPath,[]);
  this.issueRunner=issueRunner||this.defaultIssueRunner.bind(this);
  this.issueCache=new Map();this.running=false;
  this.timer=null;this.nextTick=null;this.latest=null;
  if(autoSchedule)this.schedule();
 }
 save(){
  this.status.dispatches=this.status.dispatches.slice(-350);
  atomic(this.statePath,this.status);
 }
 log(event,record={}){
  const row={at:new Date(this.clock()).toISOString(),event,...record};
  fs.appendFileSync(this.eventsPath,JSON.stringify(row)+'\n');
  this.audit('sustain_'+event,record);
 }
 schedule(){
  if(this.timer)clearInterval(this.timer);
  if(!this.config.enabled){this.timer=null;this.nextTick=null;return}
  this.nextTick=new Date(this.clock()+this.config.intervalSeconds*1000).toISOString();
  this.timer=setInterval(()=>{
   this.tick().catch(e=>this.failure(e));
   this.nextTick=new Date(this.clock()+this.config.intervalSeconds*1000).toISOString();
  },this.config.intervalSeconds*1000);
  this.timer.unref?.();
 }
 enable(enabled){
  if(typeof enabled!=='boolean')throw Error('enabled must be boolean');
  this.config.enabled=enabled;atomic(this.configPath,this.config);
  this.log(enabled?'enabled':'disabled',{});
  this.schedule();
  if(enabled&&this.timer){setTimeout(()=>this.tick().catch(e=>this.failure(e)),200).unref?.()}
  return this.summary();
 }
 update(changes){
  const allowed=new Set(Object.keys(DEF).filter(k=>k!=='enabled'));
  for(const k of Object.keys(changes||{}))if(!allowed.has(k))throw Error('Unknown setting '+k);
  this.config=verifySettings({...this.config,...changes});
  atomic(this.configPath,this.config);this.schedule();
  this.log('settings',{changes});
  return this.summary();
 }
 summary(){
  const recent=this.status.dispatches.filter(x=>this.clock()-parse(x.at)<3600000);
  return {
   enabled:this.config.enabled,running:this.running,config:clone(this.config),nextTick:this.nextTick,
   lastTick:this.status.lastTick,lastSuccess:this.status.lastSuccess,lastError:this.status.lastError?short():null,
   quotaPausedUntil:this.status.quotaPausedUntil,
   sentTotal:this.status.sentTotal||0,sentThisHour:recent.length,
   productivity:this.productivity.summary(),artifactReviews:this.artifactReviews.summary(),deliveryReconciliation:this.deliveryReconciliation||null,
    leases:Object.values(this.status.leases).map(l=>({issue:l.issue,session:l.session,scope:l.scope,state:l.state,at:l.at})),
    workItems:Object.values(this.status.workItems).map(w=>({issue:w.issue,session:w.session,state:w.state,approvedAt:w.approvedAt,completedAt:w.completedAt||null})),
   activity:publicState(this.status.dispatches.slice(-12).reverse(),'sustain'),latest:publicState(this.latest,'sustain')
  };
 }
 async defaultIssueRunner(n){
  const x=await execAsync('gh.exe',['issue','view',String(n),'--repo','MulattoTech/MJobs','--json','number,title,state,labels,assignees'],{windowsHide:true,timeout:17000,maxBuffer:160000});
  return JSON.parse(x.stdout);
 }
 async issue(n){
  const cached=this.issueCache.get(n);
  if(cached&&this.clock()-cached.at<600000)return cached.value;
  const value=await this.issueRunner(n);this.issueCache.set(n,{value,at:this.clock()});
  return value;
 }
 fingerprint(session,gh){
  const ps=(session.prs||[]).filter(x=>['open','draft'].includes(x.state)).map(p=>{
   const live=(gh?.open||[]).find(x=>Number(x.number)===Number(p.number));
   const failures=(live?.statusCheckRollup||[]).filter(x=>x.conclusion==='FAILURE'||x.conclusion==='TIMED_OUT').length;
   return String(p.number)+':'+(live?.headRefOid||'')+':'+(live?.isDraft?'draft':'open')+':'+failures+':'+(live?.reviewDecision||'');
  }).sort();
  return [session.status||'',session.branchState?.commits||0,session.branchState?.unpushed||0,session.openPRs||0,...ps].join('|');
 }
 observe(sessions,gh){
  const now=this.clock();
  for(const s of sessions){
   const a=this.status.agents[s.id] ||= {};
   const fingerprint=this.fingerprint(s,gh);
   if(a.lastSent&&(s.busy||s.activity==='active'||s.activity==='working')){
    // A running turn confirms delivery even when AO's activity timestamp is
    // the turn-start time. Never time out a still-running turn as undelivered.
    a.awaiting=true;a.observedActiveAt=new Date(now).toISOString();
    if(a.backoffReason==='unverified_delivery'||(!a.backoffReason&&(a.unverified||0)>0)){
     delete a.backoffUntil;delete a.backoffReason;
    }
    a.unverified=0;
    continue;
   }
   // A source-bound completed artifact proves a short maintenance turn was
   // delivered even if the native activity sampler missed its active interval.
   const receipt=['productive','artifact_review'].includes(a.lastType)&&(this.latestProductiveTasks||[]).find(t=>t.id===a.lastKey&&t.agentId===s.id&&['artifact_ready','no_new_gap','review_ready'].includes(t.state));
   if(receipt&&a.lastSent&&canReceiveInstruction(s)&&parse(receipt.completedAt)>=parse(a.lastSent)&&parse(receipt.completedAt)<=now+1000){
    a.awaiting=false;a.completedAt=receipt.completedAt;a.productiveReceiptKey=receipt.id;
    a.noProgress=0;a.unverified=0;a.lastFingerprint=fingerprint;
    if(a.backoffReason==='unverified_delivery'){delete a.backoffUntil;delete a.backoffReason;}
    continue;
   }
   if(a.lastSent && a.awaiting){
    const sent=parse(a.lastSent);
    const activity=parse(s.lastActivity);
    if(parse(a.observedActiveAt)>=sent||activity>sent+300){
     a.awaiting=false;a.completedAt=s.lastActivity;
     a.noProgress=(a.lastFingerprint===fingerprint)?(a.noProgress||0)+1:0;
     a.lastFingerprint=fingerprint;
     a.lastObservedActivity=activity;
    }else if(now-sent>180000){
     a.awaiting=false;a.unverified=(a.unverified||0)+1;
     a.backoffUntil=new Date(now+Math.min(45,a.unverified*12)*60000).toISOString();
     a.backoffReason='unverified_delivery';
     this.log('unverified_delivery',{id:s.id,backoffUntil:a.backoffUntil});
    }
   }
   if(!a.lastFingerprint)a.lastFingerprint=fingerprint;
   }
  }
  approveIssue(issue,session){
   if(!Number.isInteger(issue)||issue<1||typeof session!=='string')throw Error('Invalid issue approval');
   const task=this.taskBank.find(t=>t.issue===issue&&t.session===session);
   if(!task)throw Error('Issue is not in the curated task bank for this session');
   if(this.status.workItems[issue]||this.status.leases[issue])throw Error('Issue already has a work item or lease');
    this.status.workItems[issue]={issue,session,scope:clone(task.scope),focus:task.focus,state:'approved',approvedAt:new Date(this.clock()).toISOString()};
   this.save();this.log('work_item_approved',{issue,session});return clone(this.status.workItems[issue]);
  }
  completeIssue(issue,evidence){
   const item=this.status.workItems[issue],lease=this.status.leases[issue];
   if(!Number.isInteger(issue)||!item||!lease||!['dispatched','in_review'].includes(item.state)||typeof evidence!=='string'||evidence.trim().length<12||evidence.length>1000)throw Error('Assigned issue and concrete completion evidence required');
   item.state='completed';item.completedAt=new Date(this.clock()).toISOString();item.evidence=evidence.trim();lease.state='complete';this.save();this.log('work_item_completed',{issue});return clone(item);
  }
  approveDocumentation(blob){const result=this.productivity.approve(blob);this.log('documentation_approved',{key:result.key});return result}
  approveReview(data){const result=this.artifactReviews.approve(data);this.log('review_approved',{key:result.key});return result}
  assessReview(key,decision){const result=this.artifactReviews.assess(key,decision);this.log('review_assessed',{key,decision});return result}
 possibleDispatch(session,type,key,message,reason,now,extra={}){
  if(!canReceiveInstruction(session)||this.deliveryLedger?.holdFor(session.id,now))return null;
  const data=this.status.agents[session.id]||{};
  if(data.awaiting)return null;
  if(parse(data.backoffUntil)>now)return null;
  const quiet=this.config.minQuietSeconds*1000;
  if(now-parse(session.lastActivity)<quiet)return null;
  if(now-parse(data.lastSent)<quiet)return null;
  if(this.signals.seen(key)||data.lastKey===key)return null;
  if(type==='root'&&now-parse(data.lastSent)<this.config.rootCooldownMinutes*60000)return null;
  const same=data.lastKey===key;
  if(same){
   if(type==='root'&&now-parse(data.lastSent)<this.config.rootCooldownMinutes*60000)return null;
   if(data.noProgress>=2&&now-parse(data.lastSent)<this.config.repeatNoProgressBackoffMinutes*60000)return null;
   if(data.noProgress>=4&&now-parse(data.lastSent)<45*60000)return null;
  }
  return {id:session.id,mode:session.mode,name:session.name,type,key,message,reason,priority:extra.priority??5,issue:extra.issue||null};
 }
 async taskFor(s,openPRs){
  // Existing reservations are not recurring assignments. Completion/escalation is a coordinator decision.
    const entries=this.taskBank.filter(e=>{const w=this.status.workItems[e.issue];return e.session===s.id&&!this.status.leases[e.issue]&&w?.state==='approved'&&w.session===s.id&&w.focus===e.focus&&JSON.stringify(w.scope)===JSON.stringify(e.scope)});
  for(const task of entries){
   if(openPRs.some(p=>RegExp('(?:#|mj.req.)'+task.issue+'(?:\\D|$)','i').test(p.title||'')))continue;
   const otherLease=Object.values(this.status.leases).find(l=>l.issue===task.issue&&l.session!==s.id&&l.state!=='complete');
   if(otherLease)continue;
   try{
    const issue=await this.issue(task.issue);
    if(issue.state!=='OPEN')continue;
    const assignees=issue.assignees||[];
    if(assignees.length>0)continue;
    if(denyTaskWords.test(task.focus||''))continue;
    const active=this.status.leases[task.issue];
    if(active&&active.state==='complete')continue;
    const paths=task.scope||[];
    if(!paths.length||paths.some(p=>!/^((tests|docs)\/)[a-z0-9_./-]+$/.test(p)||p.includes('..')))continue;
    const collision=Object.values(this.status.leases).some(l=>l.issue!==task.issue&&l.state!=='complete'&&(l.scope||[]).some(p=>paths.includes(p)));
    if(collision)continue;
    return {task,issue};
   }catch(e){this.log('issue_unavailable',{id:s.id,issue:task.issue,error:short(e),diagnostic:privateDiagnostic(e)})}
  }
  return null;
 }
 async buildPlan(){
  const snap=await this.getState(true);
  const resources=await this.turbo.signals(snap);
  // Honor Sustained Mode's separate resource envelope, not the old Turbo budget.
  resources.pausedReason=null;
  if(resources.freeRamGiB<this.config.minFreeRamGiB)
   resources.pausedReason='Low available RAM ('+resources.freeRamGiB+' GiB)';
  else if(resources.freeDiskGiB!==null&&resources.freeDiskGiB<this.config.minFreeDiskGiB)
   resources.pausedReason='Low disk space ('+resources.freeDiskGiB+' GiB)';
  else if(Number.isFinite(resources.cpuPercent)&&resources.cpuPercent>=this.config.maxCpuPercent)
   resources.throttledReason='CPU pressure ('+resources.cpuPercent+'%): using one lightweight dispatch per cycle while RAM is safe';
  const gh=await this.turbo.github();
  const now=this.clock();
  try{this.productivity.observe();}catch{this.productivity.error='Productive-work receipt inspection is unavailable';}
  try{this.artifactReviews.observe();}catch(e){this.log('review_receipts_unavailable',{reason:String(e.message).slice(0,180)});}
  const reviewSummary=this.artifactReviews.summary();
  const productiveSummary=this.productivity.summary();this.latestProductiveTasks=(productiveSummary.available?productiveSummary.tasks:[]).concat(reviewSummary.tasks||[]);
  this.observe(snap.sessions,gh);
  const prs=(gh?.open||[]).filter(p=>p.number>0);
  const liveRoot=snap.sessions.find(s=>s.kind==='orchestrator'&&!s.isTerminated&&!s.replacedBy&&s.activity!=='exited');
  const working=snap.sessions.filter(s=>s.busy).length;
  const waiting=snap.sessions.filter(s=>s.activity==='waiting_input').length;
  const pending=snap.sessions.filter(s=>!s.busy&&!s.isTerminated&&!s.replacedBy&&this.status.agents[s.id]?.awaiting===true).length;
  const actions=[],seenPR=new Set(),held=[];
  let blocked=resources.pausedReason||null;
  if(this.status.quotaPausedUntil&&parse(this.status.quotaPausedUntil)>now)blocked='Provider usage/rate limit pause until '+this.status.quotaPausedUntil;
  if(this.isManualBusy()||this.turbo.running)blocked='Another control operation is running';
  const root=liveRoot;
  if(!root)blocked='No live primary orchestrator';
  if(snap.offline)blocked='Orchestrator roster is an offline snapshot';
  if(!gh||gh.fresh===false)blocked='GitHub snapshot unavailable or stale; no automatic assignments';
  for(const s of snap.sessions){
   if(!canReceiveInstruction(s))continue;
   const deliveryHold=this.deliveryLedger?.holdFor(s.id,now);if(deliveryHold){held.push({id:s.id,...deliveryHold});continue;}
   const owned=(s.prs||[]).filter(p=>['open','draft'].includes(p.state)&&prs.some(g=>g.number===p.number));
   let message=null,reason='',type='',key='',priority=5,issueId=null;
    // A verified idle primary is the only source of new issue/file ownership.
    // Without this lane the fleet can be healthy and Sustained enabled while
    // no worker has an approved issue. One graph-bound checkpoint per 30-minute
    // period prevents repeated status-only prompts and respects all cooldowns.
    if(s.kind==='orchestrator'){
     if(s.id!==root?.id||(!prs.length&&!Object.values(this.status.workItems).some(w=>w.state==='approved')))continue;
     const failing=prs.filter(p=>(p.statusCheckRollup||[]).some(c=>['FAILURE','TIMED_OUT','ACTION_REQUIRED'].includes(c.conclusion))).length;
     const workers=snap.sessions.filter(w=>w.kind==='worker'&&canReceiveInstruction(w));
     const graph=graphSignal(snap.sessions,prs);
     key='root-coordination:'+root.id+':'+graph+':'+Math.floor(now/(30*60*1000));
     type='root';priority=0;reason='Coordinate real outstanding MJobs work and PR integration';
     message='USER-AUTHORIZED UNATTENDED MJOBS DEVELOPMENT: You are the SOLE MJobs primary integration coordinator '+root.id+'. The authoritative GitHub queue currently has '+prs.length+' open PRs, '+failing+' with failing hosted checks, and '+workers.length+' verified idle worker sessions. Do substantial, prioritized P0/P1 MJobs development; first inspect current git/PR/issue state and the repository AGENTS.md and continuity contract. Resolve existing unfinished PRs and CI failures, and delegate independent, nonoverlapping issue/file ownership to EXISTING idle workers using ao send (do not spawn or restore any agents). Keep no more than 8 concurrent turns including yourself and at most one heavy local test. Prefer working code with tests and exact-head CI evidence over status reports or duplicate documentation. Integrate only with valid branch protections and required reviews; never force push, bypass approvals, auto-merge unreviewed changes, handle credentials, or submit real job applications. Continue productive work while resource and quota guards permit; if a step is blocked, assign the next safe nonoverlapping issue rather than wait for me. When the backlog is exhausted or no safe useful work exists, report NO_NEW_GAP and park. Do not spend tokens on periodic status messages without work. '+REPORT_POLICY;
     const action=this.possibleDispatch(s,type,key,message,reason,now,{priority});
     if(action)actions.push(action);
     continue;
    }
    if(owned.length){
    const options=owned.map(p=>({pr:prs.find(x=>x.number===p.number),signal:prSignal(prs.find(x=>x.number===p.number))})).filter(x=>x.signal);
    options.sort((a,b)=>(a.signal.kind==='ci'?0:1)-(b.signal.kind==='ci'?0:1)||a.pr.number-b.pr.number);
    const next=options.find(x=>!this.signals.seen(x.signal.key));
    if(!next){held.push({id:s.id,reason:options.length?'Unchanged PR outcome already dispatched':'Hosted checks are still running; no repeat audit'});continue;}
    const {pr,signal}=next;key=signal.key;type=signal.kind;priority=type==='ci'?1:2;
    reason=(type==='ci'?'Repair failing CI':'Coordinate settled PR')+' #'+pr.number+'@'+pr.headRefOid.slice(0,12);
    message='MJobs '+(type==='ci'?'CI REMEDIATION':'PR CHECKS SETTLED')+': existing PR #'+pr.number+' at '+pr.headRefOid+'. '+(type==='ci'?'Inspect the concrete failed check and fix a proven defect only within existing ownership.':'The reported checks have settled; this is NOT acceptance or merge approval. Resolve specific review findings or send the primary the exact next integration action.')+' Preserve existing work and branch protections. Do not add duplicate tests, invent a gap, force-push, create a duplicate PR or repeat a completed audit. A new assignment requires an actual unmet acceptance criterion, not an idle worker.';
   }else if(s.role?.toLowerCase().includes('review')){
    const candidates=prs.filter(p=>p.headRefOid&&!seenPR.has(p.number)&&!this.status.reviewHeads[p.number+':'+p.headRefOid]&&!this.signals.seen('review:'+p.number+':'+p.headRefOid));
    candidates.sort((a,b)=>{
     const score=x=>(x.statusCheckRollup||[]).some(c=>c.conclusion==='FAILURE')?0:1;
     return score(a)-score(b)||b.number-a.number;
    });
    if(candidates.length){
     const p=candidates[0];seenPR.add(p.number);
     type='review';priority=3;issueId=null;key='review:'+p.number+':'+p.headRefOid;
     reason='Independent review of PR #'+p.number;
     message='SUSTAINED INDEPENDENT REVIEW: Inspect MJobs PR #'+p.number+' at exact current SHA '+p.headRefOid+'. Analyze acceptance criteria, security, edge cases and negative tests. Record high-confidence blockers to primary '+(root?.id||'mjobs-luna-35')+'. Do not change files, approve/merge on behalf of user, or redo the same unchanged head. If PR has a failure, identify a concrete root cause and owner action.';
    }
    }else if(s.role!=='Orchestration'){
    const found=await this.taskFor(s,prs);
    if(found){
     const {task,issue}=found;issueId=task.issue;
     const paths=task.scope.join(', ');
     const lease=this.status.leases[task.issue];
     type='issue';priority=4;key='issue:'+task.issue;
     reason='Execute P1/P0 issue #'+task.issue+' '+issue.title;
     message='USER-AUTHORIZED SUSTAINED TASK ASSIGNMENT: MJobs GitHub issue #'+task.issue+' ('+issue.title+'). This Fleet Control dispatcher reserves EXCLUSIVE WRITE OWNERSHIP of only '+paths+' to you, '+s.id+'. Goal: '+task.focus+'. Read the full issue and relevant existing implementation, add meaningful regression evidence and implement a tested focused PR within ONLY those files. You may inspect production paths read-only; if a production change or another shared file is required, report that exact ownership escalation to primary '+(root?.id||'mjobs-luna-35')+' and DO NOT modify the unreserved path. All other workers must not write these paths. Work in your isolated AO worktree, never dirty local main. Include test results, exact-head CI evidence, PR and commit provenance; do not merge, force push, change protected settings or make real applications. Continue implementation directly instead of asking for the same issue assignment again.';
    }
   }
   if(message){
    const x=this.possibleDispatch(s,type,key,message+REPORT_POLICY,reason,now,{priority,issue:issueId});
    if(x)actions.push(x);
   }
  }
   // The catalog supplies candidates only for primary-approved source blobs.
   let productivityPlan={tasks:[],reserveIds:[]};
   if(this.config.productiveWork){
    productivityPlan=this.productivity.candidates(snap.sessions,{signals:this.signals,now,reserveWorkers:this.config.reserveWorkers});
    for(const task of productivityPlan.tasks){
     const s=snap.sessions.find(x=>x.id===task.agentId),existing=actions.find(x=>x.id===task.agentId);
     if(existing)continue;
     const action=this.possibleDispatch(s,'productive',task.key,task.message,'Document approved module contracts: '+task.sourcePath,now,{priority:6});
     if(action)actions.push({...action,productiveTask:task});
    }
   }
  if(this.config.productiveWork){
   for(const task of this.artifactReviews.candidates(snap.sessions,this.productivity,{signals:this.signals,now})){
    const s=snap.sessions.find(x=>x.id===task.agentId),existing=actions.find(x=>x.id===task.agentId);
    if(existing&&!['refill','productive'].includes(existing.type))continue;
    const action=this.possibleDispatch(s,'artifact_review',task.key,task.message,'Independently review existing draft: '+task.sourcePath,now,{priority:5});
    if(!action)continue;if(existing)actions.splice(actions.indexOf(existing),1);actions.push({...action,reviewTask:task});
   }
  }
  const fairScore=a=>{
   const prior=this.status.agents[a.id]||{};
   const age=(now-parse(prior.lastSent))/60000;
   let extra=0;
   if(prior.lastSent&&age<12)extra+=6;
   else if(prior.lastSent&&age<30)extra+=2;
   if((prior.noProgress||0)>=2)extra+=4;
   return a.priority+extra;
  };
  actions.sort((a,b)=>fairScore(a)-fairScore(b)||a.id.localeCompare(b.id,undefined,{numeric:true}));
  const capacity=Math.max(0,this.config.targetWorking-working-pending);
  const effectiveBatch=resources.throttledReason?1:this.config.maxDispatchPerTick;
  const selected=actions.slice(0,Math.min(capacity,effectiveBatch));
  return {
   observedAt:new Date(now).toISOString(),snapshot:snap,gh,resources,blocked,working,pending,waiting,held,rootId:root?.id||null,
   reserveIds:productivityPlan.reserveIds,productiveError:productivityPlan.error||null,
   proposed:actions.map(({id,type,priority,reason,issue},index)=>({id,type,priority,reason,issue,queuePosition:index+1,etaSeconds:blocked||index>=capacity?null:Math.max(0,Math.ceil(((this.nextTick?parse(this.nextTick):now)-now)/1000))+Math.floor(index/Math.max(1,effectiveBatch))*this.config.intervalSeconds,etaKind:'estimate_if_capacity_unchanged'})),
   selected,eligible:actions.length,leases:Object.keys(this.status.leases).length
  };
 }
 async preview(){
  if(this.running)throw Error('Sustained dispatch already running');
  const p=await this.buildPlan();
  this.latest={at:p.observedAt,enabled:this.config.enabled,blocked:p.blocked,working:p.working,pending:p.pending,waiting:p.waiting,rootId:p.rootId,resources:p.resources,eligible:p.eligible,proposed:p.proposed.slice(0,100),reserveIds:p.reserveIds,productiveError:p.productiveError,selected:p.selected.map(x=>({id:x.id,type:x.type,reason:x.reason,issue:x.issue})),leases:p.leases,held:p.held};
  return clone(this.latest);
 }
 async tick({forced=false,dryRun=false}={}){
  if(this.running)return {skipped:'already running'};
  if(!this.config.enabled&&!forced)return {skipped:'disabled'};
  this.running=true;
  const now=this.clock();
  const selected=[];
  try{
   const p=await this.buildPlan();
   this.latest={at:p.observedAt,enabled:this.config.enabled,blocked:p.blocked,working:p.working,pending:p.pending,waiting:p.waiting,rootId:p.rootId,resources:p.resources,eligible:p.eligible,proposed:p.proposed.slice(0,100),reserveIds:p.reserveIds,productiveError:p.productiveError,selected:p.selected.map(x=>({id:x.id,type:x.type,reason:x.reason,issue:x.issue})),leases:p.leases,held:p.held};
   this.status.lastTick=new Date(now).toISOString();this.status.ticks=(this.status.ticks||0)+1;
   if(p.blocked||dryRun){this.save();return {sent:[],blocked:p.blocked,preview:this.latest,dryRun}}
   for(const action of p.selected){
    if((!this.config.enabled&&!forced)||this.isManualBusy())break;
    const live=await this.getState(true);
    if((!this.config.enabled&&!forced)||this.isManualBusy()||this.turbo.running)break;
    const occupied=live.sessions.filter(s=>!s.isTerminated&&!s.replacedBy&&(s.busy||this.status.agents[s.id]?.awaiting===true)).length;
    if(live.offline||occupied>=this.config.targetWorking||!live.sessions.some(s=>s.kind==='orchestrator'&&!s.isTerminated&&!s.replacedBy&&s.activity!=='exited'))break;
    const resources=await this.turbo.signals(live);
    if(resources.freeRamGiB<this.config.minFreeRamGiB||(resources.freeDiskGiB!==null&&resources.freeDiskGiB<this.config.minFreeDiskGiB))break;
    if((!this.config.enabled&&!forced)||this.isManualBusy()||this.turbo.running)break;
    const current=live.sessions.find(s=>s.id===action.id);
    if(!canReceiveInstruction(current))continue;
    const a=this.status.agents[action.id]||{};
    if(a.awaiting&&parse(a.lastSent)>0)continue;
     if(['pr','ci','review'].includes(action.type)){
      const fresh=await this.turbo.github();
      const number=Number(action.key.split(':')[1]),livePR=(fresh?.open||[]).find(p=>p.number===number);
      if(fresh?.fresh===false||!livePR||!(action.type==='review'?action.key==='review:'+number+':'+livePR.headRefOid:prSignal(livePR)?.key===action.key))continue;
     }
    if(action.type==='review'){
     const k=action.key.slice('review:'.length);
     if(this.status.reviewHeads[k])continue;
    }
    if(this.deliveryLedger?.holdFor(action.id,this.clock()))continue;
    if(action.type==='productive'&&!this.productivity.reserve(action.productiveTask,this.clock()))continue;
    if(action.type==='artifact_review'&&!this.artifactReviews.reserve(action.reviewTask))continue;
    if(!this.signals.reserve(action.key,action.id,this.clock()))continue;
    if(action.type==='issue'){
     const task=this.taskBank.find(t=>t.issue===action.issue&&t.session===action.id);
     if(!task)continue;
     const previous=this.status.leases[task.issue];
     if(previous&&previous.session!==action.id)continue;
      this.status.leases[task.issue]={issue:task.issue,session:action.id,scope:task.scope,state:'assigned',at:new Date(this.clock()).toISOString()};
      this.status.workItems[task.issue].state='dispatching';
    }
    const stamp=new Date(this.clock()).toISOString();
    this.status.agents[action.id]={...a,lastSent:stamp,lastKey:action.key,lastReason:action.reason,lastType:action.type,lastFingerprint:this.fingerprint(current,p.gh),awaiting:true,observedActiveAt:null,backoffReason:null,askedForTask:action.type==='refill'||a.askedForTask||false};
    this.save();
    const args=['send','--session',action.id,'--message',action.message];
    if(current.mode==='chat')args.push('--steer','--client-message-id',randomUUID());
    try{
     await this.command(args,25000);
     this.signals.finish(action.key,'submitted');
      if(action.type==='issue')this.status.workItems[action.issue].state='dispatched';
     if(action.type==='productive')this.productivity.finish(action.key,'submitted');
     if(action.type==='artifact_review')this.artifactReviews.finish(action.key,'submitted');
     if(action.type==='review')this.status.reviewHeads[action.key.slice('review:'.length)]={at:stamp,reviewer:action.id};
     const row={at:stamp,id:action.id,type:action.type,issue:action.issue,status:'submitted',reason:action.reason};
     this.status.dispatches.push(row);this.status.sentTotal=(this.status.sentTotal||0)+1;
     this.log('sent',row);this.status.lastSuccess=stamp;this.status.lastError=null;
     selected.push({id:action.id,type:action.type,reason:action.reason});
    }catch(e){
     this.signals.finish(action.key,'uncertain');
     if(action.type==='productive')this.productivity.finish(action.key,'uncertain');
     if(action.type==='artifact_review')this.artifactReviews.finish(action.key,'uncertain');
     const message=short(e);
     this.status.agents[action.id].awaiting=false;
     if(action.issue&&this.status.leases[action.issue])this.status.leases[action.issue].state='delivery_uncertain';
      if(action.type==='issue')this.status.workItems[action.issue].state='reconciliation_required';
     this.status.agents[action.id].backoffUntil=new Date(this.clock()+20*60000).toISOString();
     this.status.agents[action.id].backoffReason='dispatch_error';
     if(isUsageLimit(e)){
      this.status.quotaPausedUntil=new Date(this.clock()+20*60000).toISOString();
      this.log('provider_pause',{message,diagnostic:privateDiagnostic(e),until:this.status.quotaPausedUntil});
     }else this.log('uncertain',{id:action.id,message,diagnostic:privateDiagnostic(e)});
     this.status.lastError=message;
     this.save();
     break;
    }
    this.save();
   }
   this.save();
   return {sent:selected,blocked:null,preview:this.latest};
  }catch(e){
   this.failure(e);
   if(forced)throw new Error(short());
   return {sent:selected,error:short(e)};
  }finally{this.running=false}
 }
 failure(e){this.status.lastError=short(e);this.log('error',{message:this.status.lastError,diagnostic:privateDiagnostic(e)});this.save()}
}
module.exports={Sustain,DEF,verifySettings};
