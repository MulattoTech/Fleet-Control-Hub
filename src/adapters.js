'use strict';
const DEFAULT_ENDPOINTS = Object.freeze({
  mjobs: 'http://127.0.0.1:8787',
  babytracker: 'http://127.0.0.1:4319'
});
const {readMJobsProgress,babyProgress,mjobsLifecycle}=require('./progress');

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
function summarizeBaby(raw) {
  if (raw?.projectId !== 'babytracker' || !Array.isArray(raw.sessions)) throw Error('BabyTracker identity or session feed changed');
  const tasks = Array.isArray(raw.tasks) ? raw.tasks : [];
  return { id:'babytracker', name:'BabyTracker', online:raw.runtime?.online === true, mode:safeMode(raw.mode),
    total:int(raw.summary?.total), working:int(raw.summary?.working), idle:int(raw.summary?.available),
    pending:tasks.filter(t => ['queued','submitted','awaiting_reconciliation'].includes(t.status)).length,
    attention:int(raw.summary?.blocked), review:safeMode(raw.acceptance?.status || 'NOT_ASSESSED'),
    controlUrl:DEFAULT_ENDPOINTS.babytracker, detail:raw.runtime?.online === false ? 'AO feed unavailable' : null };
}

function createAdapters({ endpoints=DEFAULT_ENDPOINTS, fetcher=fetch, progressReader=readMJobsProgress }={}) {
  const urls = Object.fromEntries(Object.entries(endpoints).map(([id,url])=>[id,loopbackEndpoint(url)]));
  if (!urls.mjobs || !urls.babytracker) throw Error('Both controller origins are required');
  async function read(id,path) {
    const response=await fetcher(urls[id]+path,{signal:AbortSignal.timeout(3500),headers:{Host:new URL(urls[id]).host}});
    if (!response.ok) throw Error('Controller returned HTTP '+response.status);
    return response.json();
  }
  async function status(id) {
    try {
      if(id==='mjobs') {const raw=await read(id,'/api/state'); let master=null,sustain=null;try{master=await read(id,'/api/master')}catch{};try{sustain=await read(id,'/api/sustain')}catch{};return {...summarizeMJobs(raw,master),controlUrl:urls[id],progress:{...progressReader(),lifecycle:mjobsLifecycle(sustain)}};}
      if(id==='babytracker') {const raw=await read(id,'/api/state');return {...summarizeBaby(raw),controlUrl:urls[id],progress:babyProgress(raw)};}
      throw Error('Unknown fleet');
    } catch(e) {return {id,name:id==='mjobs'?'MJobs':'BabyTracker',online:false,mode:'unavailable',total:null,working:null,idle:null,pending:null,attention:null,review:'unavailable',controlUrl:urls[id],detail:String(e.message).slice(0,130)};}
  }
  async function startPreview(id) {
    if(!['mjobs','babytracker'].includes(id))throw Error('Unknown fleet');
    if(id==='mjobs'){
      const [startup,quota]=await Promise.all([read(id,'/api/startup'),read(id,'/api/quota')]);
      return {id,confirmation:'START MJobs',targetCount:int(startup.preview?.targetCount),phase:safeMode(startup.run?.phase),active:startup.run?.active===true,
        quotaFresh:quota.fresh===true,quotaRemaining:Number.isFinite(quota.policy?.remainingPercent)?quota.policy.remainingPercent:null,
        blocked:quota.policy?.blocked===true||startup.run?.active===true||startup.run?.reconciliationRequired===true||['failed','uncertain'].includes(startup.run?.phase),
        note:'Protected Startup restores the saved MJobs roster and then enables Sustained dispatch. It can consume Codex allowance.'};
    }
    const state=await read(id,'/api/state');
    if(state.projectId!=='babytracker')throw Error('BabyTracker identity changed');
    return {id,confirmation:'START BabyTracker',targetCount:int(state.summary?.total),phase:safeMode(state.mode),active:state.mode==='running',
      quotaFresh:state.quota?.fresh===true,quotaRemaining:Number.isFinite(state.quota?.remainingPercent)?state.quota.remainingPercent:null,
      blocked:['draining','emergency','running'].includes(state.mode)||state.quota?.fresh!==true||Number(state.quota?.remainingPercent)<Number(state.quotaPolicy?.minimumAllowedPercent||15),
      note:'BabyTracker Start opens a bounded run and may provision one Codex session. No initial task is sent automatically.'};
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
    if(confirmation!==preview.confirmation)throw Error('Exact start confirmation required');
    if(preview.blocked||!preview.quotaFresh)throw Error('Current controller or quota state blocks start');
    const origin=urls[id];const headers={'content-type':'application/json','origin':origin,'host':new URL(origin).host};
    let route,body;
    if(id==='mjobs'){
      if(!Number.isInteger(preview.targetCount)||preview.targetCount<1||typeof requestId!=='string'||!/^[A-Za-z0-9._:-]{8,128}$/.test(requestId))throw Error('Valid roster and stable request ID required');
      route='/api/startup';body={confirm:'STARTUP',requestId,openUi:false,startWorkAfter:true};headers['x-ao-fleet']='1';
    }else{
      route='/api/action';body={action:'start'};const session=await read(id,'/api/session');if(typeof session.token!=='string'||session.token.length<32)throw Error('BabyTracker action token unavailable');headers['x-babytracker-fleet']=session.token;
    }
    const response=await fetcher(origin+route,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
    const result=await response.json();if(!response.ok||result?.error||result?.ok===false)throw Error(String(result?.error||result?.note||'Controller refused start').slice(0,200));
    return {ok:true,id,note:id==='mjobs'?'Protected Startup requested. Follow its stages and verify dispatch before treating the fleet as running.':'BabyTracker bounded Start acknowledged. Refresh status to verify.'};
  }
  return {status,startPreview,start,control,pause:id=>control(id,'pause'),urls};
}
module.exports={DEFAULT_ENDPOINTS,loopbackEndpoint,summarizeMJobs,summarizeBaby,createAdapters};
