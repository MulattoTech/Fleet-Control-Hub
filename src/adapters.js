'use strict';
const DEFAULT_ENDPOINTS = Object.freeze({
  mjobs: 'http://127.0.0.1:8787',
  babytracker: 'http://127.0.0.1:4319'
});
const {readMJobsProgress,babyProgress,mjobsLifecycle,mjobsPipeline,readMJobsReviewCandidates}=require('./progress');
const LIMIT_PROFILES=Object.freeze({
  babytracker:{run:{label:'Run budget',route:'/api/action',fields:{concurrency:[1,32],maxDispatches:[1,1000],maxMinutes:[1,720]}}},
  mjobs:{sustain:{label:'Sustained dispatch',route:'/api/sustain/config',fields:{targetWorking:[3,64],maxDispatchPerTick:[1,12]}},
    turbo:{label:'Turbo dispatch',route:'/api/turbo/config',fields:{targetWorking:[1,25],maxActionsPerCycle:[1,6],maxActionsPerHour:[1,60]}}}
});

function loopbackEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw Error('Controller endpoints must be plain loopback HTTP origins');
  }
  return url.origin;
}

function int(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function safeMode(value) { return typeof value === 'string' ? value.slice(0, 50) : 'unknown'; }
function summarizeMJobs(raw, master) {
  if (raw?.projectId !== 'mjobs-luna' || !Array.isArray(raw.sessions)) throw Error('MJobs identity or session feed changed');
  return { id:'mjobs', name:'MJobs', online:!raw.offline, mode: master?.dispatch?.sustainedEnabled ? 'sustained' : master?.dispatch?.turboEnabled ? 'turbo' : 'paused or manual',
    total:int(raw.summary?.total), working:int(raw.summary?.working), idle:int(raw.summary?.idle),
    pending:int(raw.summary?.idlePending), attention:int(raw.summary?.ciAttention),
    review:'Review state is managed in MJobs', controlUrl:DEFAULT_ENDPOINTS.mjobs,
    detail:raw.offline ? 'Preserved state; live AO feed unavailable' : null };
}
function mjobsSafety(master,quota){return {dispatchEnabled:master?.dispatch?.sustainedEnabled===true||master?.dispatch?.turboEnabled===true,emergencyScope:'machine',
  emergency:master?.emergency?.latched===true,gracefulStop:master?.drain?.enabled===true,
  codexQuotaFresh:quota?.fresh===true,codexRemaining:Number.isFinite(quota?.policy?.remainingPercent)?quota.policy.remainingPercent:null};}
function summarizeBaby(raw) {
  if (raw?.projectId !== 'babytracker' || !Array.isArray(raw.sessions)) throw Error('BabyTracker identity or session feed changed');
  const tasks = Array.isArray(raw.tasks) ? raw.tasks : [];
  return { id:'babytracker', name:'BabyTracker', online:raw.runtime?.online === true, mode:safeMode(raw.mode),
    total:int(raw.summary?.total), working:int(raw.summary?.working), idle:int(raw.summary?.available),
    pending:tasks.filter(t => ['queued','submitted','awaiting_reconciliation'].includes(t.status)).length,
    attention:int(raw.summary?.blocked), review:safeMode(raw.acceptance?.status || 'NOT_ASSESSED'),
    controlUrl:DEFAULT_ENDPOINTS.babytracker, detail:raw.runtime?.online === false ? 'AO feed unavailable' : null };
}
function babySafety(raw){return {dispatchEnabled:raw.mode==='running',emergency:raw.mode==='emergency',emergencyScope:'project',gracefulStop:raw.mode==='draining',
  codexQuotaFresh:raw.quota?.fresh===true,codexRemaining:Number.isFinite(raw.quota?.remainingPercent)?raw.quota.remainingPercent:null};}

function createAdapters({ endpoints=DEFAULT_ENDPOINTS, fetcher=fetch, progressReader=readMJobsProgress, reviewReader=readMJobsReviewCandidates }={}) {
  const urls = Object.fromEntries(Object.entries(endpoints).map(([id,url])=>[id,loopbackEndpoint(url)]));
  if (!urls.mjobs || !urls.babytracker) throw Error('Both controller origins are required');
  async function read(id,path) {
    const response=await fetcher(urls[id]+path,{signal:AbortSignal.timeout(3500),headers:{Host:new URL(urls[id]).host}});
    if (!response.ok) throw Error('Controller returned HTTP '+response.status);
    return response.json();
  }
  async function status(id) {
    try {
      if(id==='mjobs') {
        const raw=await read(id,'/api/state'); let master=null,sustain=null,quota=null,run=null;
        try{master=await read(id,'/api/master')}catch{};try{sustain=await read(id,'/api/sustain')}catch{};try{quota=await read(id,'/api/quota')}catch{};
        try{const value=await read(id,'/api/run');if(value.projectId==='mjobs-luna')run=value;}catch{}
        const evidence=progressReader(),lifecycle=mjobsLifecycle(sustain),summary=summarizeMJobs(raw,master);
        summary.start={known:!!run,phase:run?.phase,active:run?.active===true,running:run?.running===true,pendingKind:run?.pending?.kind||null,quota:run?.quota?{fresh:run.quota.fresh===true,remainingPercent:run.quota.remainingPercent,minimumRemainingPercent:run.quota.minimumRemainingPercent,blocked:run.quota.blocked===true,reason:typeof run.quota.reason==='string'?run.quota.reason.slice(0,300):null}:null,blockedReasons:Array.isArray(run?.blockedReasons)?run.blockedReasons.filter(x=>typeof x==='string').map(x=>x.slice(0,300)):[]};
        if(run){summary.mode=run.active===true?'starting':run.running===true?'running':safeMode(run.phase);if(run.error)summary.detail=String(run.error).slice(0,200);}
        return {...summary,controlUrl:urls[id],safety:mjobsSafety(master,quota),progress:{...evidence,lifecycle,pipeline:mjobsPipeline(lifecycle,evidence)}};
      }
      if(id==='babytracker') {const raw=await read(id,'/api/state');return {...summarizeBaby(raw),controlUrl:urls[id],safety:babySafety(raw),start:{known:true,phase:raw.mode==='running'?'running':raw.mode==='paused'?'paused':'blocked',running:raw.mode==='running',active:false,quota:{fresh:raw.quota?.fresh===true,remainingPercent:raw.quota?.remainingPercent,minimumRemainingPercent:raw.quotaPolicy?.minimumAllowedPercent,blocked:raw.quota?.blocked===true},blockedReasons:['pending','uncertain'].includes(raw.bootstrap?.status)?['A native launch needs reconciliation.']:raw.mode==='draining'?['Graceful stop is in progress.']:[]},progress:babyProgress(raw)};}
      throw Error('Unknown fleet');
    } catch(e) {return {id,name:id==='mjobs'?'MJobs':'BabyTracker',online:false,mode:'unavailable',total:null,working:null,idle:null,pending:null,attention:null,review:'unavailable',controlUrl:urls[id],detail:String(e.message).slice(0,130)};}
  }
  async function startPreview(id) {
    if(!['mjobs','babytracker'].includes(id))throw Error('Unknown fleet');
    if(id==='mjobs'){
      const run=await read(id,'/api/run');
      if(run.projectId!=='mjobs-luna')throw Error('MJobs run identity changed');
      const quota=run.quota||{},reasons=Array.isArray(run.blockedReasons)?run.blockedReasons.filter(r=>typeof r==='string'):[];
      if(!['idle','starting','running','paused','blocked','uncertain'].includes(run.phase))reasons.push('Native run phase is unknown');
      if(run.phase==='uncertain'&&!['spawn','resume'].includes(run.pending?.kind)&&!reasons.length)reasons.push('Native MJobs run needs reconciliation');
      const minimum=quota.minimumRemainingPercent??0;
      if(!Number.isFinite(minimum)||minimum<0||(quota.fresh===true&&(!Number.isFinite(quota.remainingPercent)||quota.remainingPercent<=minimum||quota.blocked===true)))reasons.push(quota.reason||'Codex quota policy blocks new work');
      return {id,confirmation:'START MJobs',targetCount:1,primaryId:run.primaryId??null,phase:safeMode(run.phase),active:run.active===true,running:run.running===true,
        quotaFresh:quota.fresh===true,quotaRemaining:Number.isFinite(quota.remainingPercent)?quota.remainingPercent:null,
        blocked:reasons.length>0,blockedReasons:reasons,
        note:'Start resumes the MJobs primary and Sustained dispatch using the saved quota reserve.'};
    }
    const state=await read(id,'/api/state');
    if(state.projectId!=='babytracker')throw Error('BabyTracker identity changed');
    const reasons=[];
    if(!['paused','running','draining','emergency'].includes(state.mode))reasons.push('Controller mode is not recognized as safe to start');
    if(['pending','uncertain'].includes(state.bootstrap?.status))reasons.push('Codex bootstrap needs native reconciliation');
    if(state.quota?.fresh!==true)reasons.push('Codex quota sample is stale');
    if(!Number.isFinite(state.quota?.remainingPercent)||state.quota.remainingPercent<=Number(state.quotaPolicy?.minimumAllowedPercent??0))reasons.push('Codex quota is below or unavailable at the start threshold');
    return {id,confirmation:'START BabyTracker',targetCount:int(state.summary?.total),phase:safeMode(state.mode),active:state.mode==='running',
      quotaFresh:state.quota?.fresh===true,quotaRemaining:Number.isFinite(state.quota?.remainingPercent)?state.quota.remainingPercent:null,
      blocked:reasons.length>0,blockedReasons:reasons,
      note:'Start resumes BabyTracker using the saved limits and quota reserve.'};
  }
  async function boundedStartPreview(id) {
    if(id!=='mjobs')throw Error('One-session Startup is available only for MJobs');
    const [native,state,master,startup,quota]=await Promise.all([
      read(id,'/api/startup/mjobs-bounded-preview'),read(id,'/api/state'),read(id,'/api/master'),read(id,'/api/startup'),read(id,'/api/quota')]);
    const reasons=[];
    if(native.projectId!=='mjobs-luna'||native.boundedStartSupported!==true||native.dispatchAfter!==false||native.targetCount!==1||
       typeof native.primaryId!=='string'||!/^mjobs-luna-[0-9]+$/.test(native.primaryId)||
       typeof native.manifestRevision!=='string'||!/^[a-f0-9]{64}$/.test(native.manifestRevision))reasons.push('Native one-session binding is unavailable');
    if(state.projectId!=='mjobs-luna'||!Array.isArray(state.sessions)||state.sessions.some(s=>s.status!=='exited'||s.activity!=='exited'))reasons.push('All MJobs sessions must be exited before this test');
    if(master.dispatch?.sustainedEnabled!==false||master.dispatch?.turboEnabled!==false)reasons.push('MJobs dispatch must be paused');
    if(master.drain?.enabled===true||master.emergency?.latched===true)reasons.push('MJobs stop or emergency is active');
    if(startup.run?.active===true||startup.run?.reconciliationRequired===true||startup.run?.phase==='uncertain')reasons.push('Protected Startup is active or needs reconciliation');
    if(quota.fresh!==true||quota.policy?.blocked===true||!Number.isFinite(quota.policy?.remainingPercent)||quota.policy.remainingPercent<=15)reasons.push('Fresh Codex quota above the start threshold is required');
    return {id,mode:'one-session',confirmation:'START ONE MJobs',targetCount:1,primaryId:native.primaryId,manifestRevision:native.manifestRevision,
      quotaFresh:quota.fresh===true,quotaRemaining:Number.isFinite(quota.policy?.remainingPercent)?quota.policy.remainingPercent:null,
      blocked:reasons.length>0,blockedReasons:reasons,
      note:'Restore only the saved MJobs primary. Automatic dispatch stays off. This can briefly use Codex quota; stop the session when finished.'};
  }
  async function boundedStart(id,confirmation,requestId,manifestRevision,primaryId){
    const preview=await boundedStartPreview(id);
    if(confirmation!==preview.confirmation)throw Error('Exact one-session confirmation required');
    if(preview.blocked||!preview.quotaFresh)throw Error('Current controller or quota state blocks one-session Startup');
    if(typeof requestId!=='string'||!/^[A-Za-z0-9._:-]{8,128}$/.test(requestId)||manifestRevision!==preview.manifestRevision||primaryId!==preview.primaryId)
      throw Error('Stable request ID and unchanged one-session binding required');
    const origin=urls[id],headers={'content-type':'application/json','origin':origin,'host':new URL(origin).host,'x-ao-fleet':'1'};
    const body={confirm:'STARTUP',requestId,openUi:false,startWorkAfter:false,expectedProjectId:'mjobs-luna',expectedManifestRevision:manifestRevision,boundedPrimaryId:primaryId};
    const response=await fetcher(origin+'/api/startup',{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
    const result=await response.json();if(!response.ok||result?.error||result?.ok===false)throw Error(String(result?.error||result?.note||'Controller refused one-session Startup').slice(0,200));
    return {ok:true,id,note:'One-session Protected Startup requested. Dispatch remains off; verify the primary before graceful stop.'};
  }
  async function control(id,action) {
    if (!['mjobs','babytracker'].includes(id)) throw Error('Unknown fleet');
    if (!['pause','graceful-stop'].includes(action)) throw Error('Unknown control action');
    const origin=urls[id];
    const headers={'content-type':'application/json','origin':origin,'host':new URL(origin).host};
    let path,body;
    if(id==='mjobs') {path=action==='pause'?'/api/master/pause':'/api/master/drain';body=action==='pause'?{}:{confirm:'GRACEFUL STOP'};headers['x-ao-fleet']='1';}
    else {path='/api/action';body={action:action==='pause'?'pause':'drain'};const session=await read(id,'/api/session');if(typeof session.token!=='string'||session.token.length<32)throw Error('BabyTracker action token unavailable');headers['x-babytracker-fleet']=session.token;}
    const response=await fetcher(origin+path,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(action==='graceful-stop'?65000:5000)});
    const result=await response.json();
    if(!response.ok || result?.error || result?.ok===false) throw Error(String(result?.error||result?.note||'Controller refused action').slice(0,200));
    return {ok:true,id,note:(action==='pause'?'Pause':'Graceful stop')+' acknowledged by '+id+' controller. Check controller status for completion.'};
  }
  async function start(id,confirmation,requestId){
    const preview=await startPreview(id);
    if(confirmation!==preview.confirmation)throw Object.assign(Error('Exact start confirmation required'),{definitive:true});
    if(preview.blocked)throw Object.assign(Error('Current controller or quota state blocks start: '+preview.blockedReasons.join('; ')),{definitive:true});
    if(typeof requestId!=='string'||!/^[A-Za-z0-9._:-]{8,128}$/.test(requestId))throw Object.assign(Error('Stable request ID required'),{definitive:true});
    const origin=urls[id];const headers={'content-type':'application/json','origin':origin,'host':new URL(origin).host};
    let route,body;
    if(id==='mjobs'){
      route='/api/run/start';body={requestId};headers['x-ao-fleet']='1';
    }else{
      route='/api/action';body={action:'simpleStart',requestId};const session=await read(id,'/api/session');if(typeof session.token!=='string'||session.token.length<32)throw Error('BabyTracker action token unavailable');headers['x-babytracker-fleet']=session.token;
    }
    const response=await fetcher(origin+route,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
    const result=await response.json();if(!response.ok||result?.error||result?.ok===false)throw Object.assign(Error(String(result?.error||result?.note||'Controller refused start').slice(0,200)),{definitive:true});
    return {ok:true,id,run:result.run,idempotent:result.idempotent===true,note:result.note||(id==='mjobs'?'MJobs Start acknowledged. Watching controller status.':'BabyTracker Start acknowledged. Watching controller status.')};
  }
  async function limits(id){
    if(!LIMIT_PROFILES[id])throw Error('Unknown fleet');
    if(id==='babytracker'){
      const state=await read(id,'/api/state');
      if(state.projectId!=='babytracker')throw Error('BabyTracker identity changed');
      return {id,editable:state.mode==='paused'&&state.summary?.working===0&&state.sessions?.every(s=>!s.runtimeActive),
        reason:'Pause and exit active sessions before editing a run budget',profiles:[limitProfile(id,'run',state.limits)]};
    }
    const [master,startup,sustain,turbo]=await Promise.all([read(id,'/api/master'),read(id,'/api/startup'),read(id,'/api/sustain'),read(id,'/api/turbo')]);
    return {id,editable:master.dispatch?.sustainedEnabled!==true&&master.dispatch?.turboEnabled!==true&&startup.run?.active!==true,
      reason:'Pause MJobs dispatch and wait for Protected Startup before editing limits',
      profiles:[limitProfile(id,'sustain',sustain.config),limitProfile(id,'turbo',turbo.config)]};
  }
  function limitProfile(id,key,config){
    const spec=LIMIT_PROFILES[id][key];if(!config||typeof config!=='object')throw Error('Native limit configuration unavailable');
    const values={};for(const field of Object.keys(spec.fields)){
      if(!Number.isSafeInteger(config[field]))throw Error('Native limit value unavailable: '+field);values[field]=config[field];
    }
    return {key,label:spec.label,fields:spec.fields,values};
  }
  async function saveLimits(id,profile,values,expected,confirmation){
    const spec=LIMIT_PROFILES[id]?.[profile];if(!spec||confirmation!=='SAVE '+id+' '+profile)throw Error('Exact project and profile confirmation required');
    const keys=Object.keys(spec.fields);
    if(!values||!expected||typeof values!=='object'||typeof expected!=='object'||Array.isArray(values)||Array.isArray(expected)||
       keys.length!==Object.keys(values).length||keys.length!==Object.keys(expected).length)throw Error('Complete limit values and expected revision required');
    for(const key of keys){const [min,max]=spec.fields[key];if(!Number.isSafeInteger(values[key])||values[key]<min||values[key]>max||!Number.isSafeInteger(expected[key]))throw Error('Invalid limit: '+key);}
    const current=await limits(id),chosen=current.profiles.find(p=>p.key===profile);
    if(!current.editable)throw Error(current.reason);
    if(keys.some(key=>chosen.values[key]!==expected[key]))throw Error('Native limits changed since preview');
    const origin=urls[id],headers={'content-type':'application/json','origin':origin,'host':new URL(origin).host};
    let body=values;if(id==='babytracker'){
      const session=await read(id,'/api/session');if(typeof session.token!=='string'||session.token.length<32)throw Error('BabyTracker action token unavailable');
      headers['x-babytracker-fleet']=session.token;body={action:'limits',limits:values};
    }else headers['x-ao-fleet']='1';
    const response=await fetcher(origin+spec.route,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
    const result=await response.json();if(!response.ok||result?.error||result?.ok===false)throw Error(String(result?.error||'Native limits update refused').slice(0,160));
    const verified=await limits(id),after=verified.profiles.find(p=>p.key===profile);
    if(keys.some(key=>after.values[key]!==values[key]))throw Error('Native limits update outcome unverified; inspect controller before retrying');
    return {ok:true,id,profile,note:'Limits verified by '+id+' controller. Fleet dispatch remains paused.'};
  }
  async function reviewCandidates(id,offset=0,limit=50){
    if(!Number.isSafeInteger(offset)||offset<0||offset>3000||!Number.isSafeInteger(limit)||limit<1||limit>3000)throw Error('Invalid review page');
    if(id==='mjobs')return {id,...reviewReader({offset,limit})};
    if(id!=='babytracker')throw Error('Unknown fleet');
    const state=await read(id,'/api/state');
    if(state.projectId!=='babytracker')throw Error('BabyTracker identity changed');
    if(state.capabilities?.reviewAssessment!==true)return {id,supported:false,total:null,candidates:[],reason:'Native BabyTracker review assessment is not installed'};
    if(!Array.isArray(state.tasks))throw Error('BabyTracker task feed unavailable');
    const rows=state.tasks.filter(t=>t&&t.status==='submitted'&&typeof t.id==='string'&&/^[a-f0-9-]{36}$/.test(t.id));
    return {id,supported:true,total:rows.length,offset,candidates:rows.slice(offset,offset+limit).map(t=>({id:t.id,issue:int(t.issue),reviewRevision:Array.isArray(t.reviewReceipts)?t.reviewReceipts.length:0}))};
  }
  async function assessReview(id,candidateId,decision,confirmation,evidenceReviewed,prNumber,reviewId){
    if(!['accepted','revision_requested','rejected'].includes(decision)||confirmation!==('ASSESS '+(id==='mjobs'?'MJobs':id==='babytracker'?'BabyTracker':''))||evidenceReviewed!==true)throw Error('Exact assessment and evidence confirmation required');
    const candidates=await reviewCandidates(id,0,3000);
    if(!candidates.supported||!candidates.candidates.some(c=>c.id===candidateId))throw Error('Review candidate is unavailable');
    const origin=urls[id],headers={'content-type':'application/json','origin':origin,'host':new URL(origin).host};
    let route,body;
    if(id==='mjobs'){
      route='/api/sustain/assess-review';body={key:candidateId,decision};headers['x-ao-fleet']='1';
    }else{
      if(!Number.isSafeInteger(prNumber)||prNumber<1||!Number.isSafeInteger(reviewId)||reviewId<1)throw Error('Exact PR and review IDs required');
      route='/api/action';body={action:'assess-task',taskId:candidateId,decision,prNumber,reviewId,confirm:'ASSESS BabyTracker'};
      const session=await read(id,'/api/session');if(typeof session.token!=='string'||session.token.length<32)throw Error('BabyTracker action token unavailable');headers['x-babytracker-fleet']=session.token;
    }
    const response=await fetcher(origin+route,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
    const result=await response.json();if(!response.ok||result?.error||result?.ok===false)throw Error(String(result?.error||'Controller refused review assessment').slice(0,200));
    return {ok:true,id,decision,note:'Assessment acknowledged by '+id+' controller. Refresh candidates to verify the durable receipt.'};
  }
  return {status,startPreview,start,boundedStartPreview,boundedStart,control,limits,saveLimits,reviewCandidates,assessReview,pause:id=>control(id,'pause'),urls};
}
module.exports={DEFAULT_ENDPOINTS,loopbackEndpoint,summarizeMJobs,summarizeBaby,createAdapters};
