'use strict';

const net=require('node:net');
const {createHmac,randomBytes}=require('node:crypto');

const SOURCE='codex-desktop-loopback-observer';
const MAX_RESPONSE_BYTES=65536;
const MAX_SESSIONS=160;
const MAX_PIDS=160;
const MAX_WORKSPACES=12;
const MAX_VISIBLE_SLICES=24;

function loopbackOrigin(value){
  let url;
  try{url=new URL(value);}catch{return null;}
  const host=url.hostname.toLowerCase();
  const ipv4=net.isIPv4(host)&&Number(host.split('.')[0])===127;
  if(url.protocol!=='http:'||(!ipv4&&host!=='localhost'&&host!=='[::1]')||
      url.username||url.password||url.pathname!=='/'||url.search||url.hash)return null;
  return url.origin;
}

function timestamp(value){
  if(typeof value!=='string'||!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value))return null;
  const milliseconds=Date.parse(value);
  return Number.isFinite(milliseconds)?milliseconds:null;
}

function object(value){return value!==null&&typeof value==='object'&&!Array.isArray(value);}

function nonnegativeCount(value){return Number.isSafeInteger(value)&&value>=0;}

function parseObserver(data,projectId,now,sliceKey){
  if(!object(data)||data.available!==true||data.read_only!==true||
      !Array.isArray(data.sessions)||data.sessions.length>MAX_SESSIONS||
      !Array.isArray(data.pids)||data.pids.length>MAX_PIDS||
      !Array.isArray(data.workspaces)||data.workspaces.length>MAX_WORKSPACES||
      !object(data.coverage)||typeof data.coverage.partial!=='boolean')return null;
  if(!data.sessions.every(object)||!data.pids.every(value=>Number.isSafeInteger(value)&&value>0)||
      !data.workspaces.every(item=>object(item)&&
        (item.changed_count===null||nonnegativeCount(item.changed_count))))return null;
  const observedMs=timestamp(data.observed_at);
  const latestMs=data.latest_activity_utc===null?null:timestamp(data.latest_activity_utc);
  if(observedMs===null||observedMs>now+300000||
      (data.latest_activity_utc!==null&&latestMs===null)||
      (latestMs!==null&&latestMs>now+300000))return null;
  const changed= data.workspaces.filter(item=>item.changed_count!==null);
  const sessions=new Map();
  let missingSessionId=false;
  for(const session of data.sessions){
    const id=session.session_id;
    if(typeof id!=='string'||!id||id.length>160){missingSessionId=true;continue;}
    const prior=sessions.get(id),latest=timestamp(session.latest_activity_utc);
    if(!prior||(latest??-Infinity)>(timestamp(prior.latest_activity_utc)??-Infinity))sessions.set(id,session);
  }
  const counts={
    session_count:sessions.size,
    active_process_count:data.pids.length,
    workspace_count:data.workspaces.length,
    changed_workspace_count:changed.filter(item=>item.changed_count>0).length,
    changed_file_count:changed.reduce((total,item)=>total+item.changed_count,0),
    workspace_status_unavailable_count:data.workspaces.length-changed.length
  };
  if(!Object.values(counts).every(nonnegativeCount))return null;
  const slices=[...sessions.values()].flatMap(session=>{
    const id=session.session_id,latest=timestamp(session.latest_activity_utc);
    if(typeof id!=='string'||!(/^[0-9a-f-]{36}$/i).test(id)||latest===null||latest>now+10000||
        !['root','subagent'].includes(session.role))return [];
    const label=createHmac('sha256',sliceKey).update(projectId+'\0'+id).digest('hex').slice(0,10);
    return [{label,role:session.role==='root'?'coordinator':'worker',latest_activity_utc:new Date(latest).toISOString()}];
  }).sort((a,b)=>b.latest_activity_utc.localeCompare(a.latest_activity_utc)).slice(0,MAX_VISIBLE_SLICES);
  return {
    project_id:projectId,
    source:SOURCE,
    observed_at:new Date(observedMs).toISOString(),
    latest_activity_utc:latestMs===null?null:new Date(latestMs).toISOString(),
    age_seconds:Math.max(0,Math.floor((now-observedMs)/1000)),
    counts,
    slices,
    coverage_partial:data.coverage.partial||missingSessionId
  };
}

function copySnapshot(snapshot,maxAgeSeconds,statusOverride){
  const age=snapshot.age_seconds;
  const status=statusOverride|| (age<=maxAgeSeconds?'fresh':'stale');
  return {
    project_id:snapshot.project_id,
    source:SOURCE,
    observed_at:snapshot.observed_at,
    latest_activity_utc:snapshot.latest_activity_utc,
    age_seconds:age,
    max_age_seconds:maxAgeSeconds,
    status,
    counts:{...snapshot.counts},
    slices:snapshot.slices.map(slice=>({...slice})),
    coverage_partial:snapshot.coverage_partial
  };
}

function createProjectDesktopActivity({projectId,originUrl,maxAgeSeconds=30,timeoutMs=2500,
    fetcher=globalThis.fetch,clock=()=>Date.now()}={}){
  if(typeof projectId!=='string'||!/^[a-z0-9][a-z0-9-]{0,63}$/.test(projectId))
    throw new TypeError('A valid project id is required');
  const origin=loopbackOrigin(originUrl);
  if(!origin)throw new TypeError('A loopback origin URL is required');
  if(!Number.isFinite(maxAgeSeconds)||maxAgeSeconds<1||maxAgeSeconds>86400)
    throw new TypeError('maxAgeSeconds must be from 1 to 86400');
  if(!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>15000)
    throw new TypeError('timeoutMs must be from 1 to 15000');
  if(typeof fetcher!=='function')throw new TypeError('A fetch function is required');

  const sliceKey=randomBytes(32);
  let lastGood=null;
  async function snapshot(){
    const readAt=clock();
    try{
      const response=await fetcher(origin+'/api/sprints/active',{
        method:'GET',redirect:'error',cache:'no-store',
        headers:{accept:'application/json'},signal:AbortSignal.timeout(timeoutMs)
      });
      if(!response||response.ok!==true)return unavailable(readAt);
      const body=await response.text();
      if(Buffer.byteLength(body,'utf8')>MAX_RESPONSE_BYTES)return unavailable(readAt);
      const projected=parseObserver(JSON.parse(body),projectId,readAt,sliceKey);
      if(!projected)return unavailable(readAt);
      if(projected.age_seconds>maxAgeSeconds){
        if(lastGood)return copySnapshot(refreshAge(lastGood,readAt),maxAgeSeconds,'stale');
        lastGood=projected;
        return copySnapshot(projected,maxAgeSeconds,'stale');
      }
      lastGood=projected;
      return copySnapshot(projected,maxAgeSeconds,'fresh');
    }catch{return unavailable(readAt);}
  }

  function refreshAge(value,readAt){
    const observedMs=Date.parse(value.observed_at);
    return {...value,age_seconds:Math.max(0,Math.floor((readAt-observedMs)/1000))};
  }
  function unavailable(readAt){
    if(lastGood)return copySnapshot(refreshAge(lastGood,readAt),maxAgeSeconds,'stale');
    return {
      project_id:projectId,source:SOURCE,observed_at:null,latest_activity_utc:null,
      age_seconds:null,max_age_seconds:maxAgeSeconds,status:'unavailable',coverage_partial:null
    };
  }
  return {snapshot};
}

module.exports={createProjectDesktopActivity};
