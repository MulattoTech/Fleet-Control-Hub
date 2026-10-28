'use strict';
const DEFAULT_ENDPOINTS = Object.freeze({
  mjobs: 'http://127.0.0.1:8787',
  babytracker: 'http://127.0.0.1:4319'
});
const {readMJobsProgress,babyProgress}=require('./progress');

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
      if(id==='mjobs') {const raw=await read(id,'/api/state'); let master=null;try{master=await read(id,'/api/master')}catch{};return {...summarizeMJobs(raw,master),controlUrl:urls[id],progress:progressReader()};}
      if(id==='babytracker') {const raw=await read(id,'/api/state');return {...summarizeBaby(raw),controlUrl:urls[id],progress:babyProgress(raw)};}
      throw Error('Unknown fleet');
    } catch(e) {return {id,name:id==='mjobs'?'MJobs':'BabyTracker',online:false,mode:'unavailable',total:null,working:null,idle:null,pending:null,attention:null,review:'unavailable',controlUrl:urls[id],detail:String(e.message).slice(0,130)};}
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
  return {status,control,pause:id=>control(id,'pause'),urls};
}
module.exports={DEFAULT_ENDPOINTS,loopbackEndpoint,summarizeMJobs,summarizeBaby,createAdapters};
