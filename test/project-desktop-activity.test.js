'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {createProjectDesktopActivity}=require('../src/project-desktop-activity');

test('per-slice projection is stable for one reader and omits upstream identifiers and content', async () => {
 const privateId='00000000-0000-4000-8000-123456789abc';
 const sample={available:true,read_only:true,observed_at:'2026-11-23T18:00:00Z',
  latest_activity_utc:'2026-11-23T18:00:00Z',pids:[],workspaces:[],coverage:{partial:false},
  sessions:[{session_id:privateId,role:'subagent',latest_activity_utc:'2026-11-23T17:59:00Z'},
   {session_id:privateId,role:'subagent',name:'sensitive name',model:'sensitive model',
   latest_activity_utc:'2026-11-23T18:00:00Z',workspace:'sensitive path'}]};
 const observer=createProjectDesktopActivity({projectId:'mjobs',originUrl:'http://127.0.0.1:18726',
  clock:()=>Date.parse(sample.observed_at),fetcher:async()=>Response.json(sample)});
 const first=await observer.snapshot(),second=await observer.snapshot();
 assert.equal(first.status,'fresh');
 assert.deepEqual(first.slices,second.slices);
 assert.equal(first.counts.session_count,1);
 assert.equal(first.slices.length,1);
 assert.match(first.slices[0].label,/^[a-f0-9]{10}$/);
 assert.equal(first.slices[0].role,'worker');
 assert.equal(first.slices[0].latest_activity_utc,'2026-11-23T18:00:00.000Z');
 assert.doesNotMatch(JSON.stringify(first),/sensitive|123456789abc|session_id|workspace":/);
});

const now=Date.parse('2026-11-23T18:00:00Z');
const observedAt='2026-11-23T17:59:50.000Z';
const source={available:true,read_only:true,observed_at:observedAt,
  observation:'RECENT_ACTIVITY',latest_activity_utc:'2026-11-23T17:59:42.000Z',
  pids:[101,202],sessions:[
    {session_id:'private-session-id',workspace:'C:/private/MJobs',name:'Private Name',
      model:'private-model',input_tokens:500,output_tokens:100},
    {session_id:'another-id',workspace:'C:/private/worktree',name:'Another Name'}
  ],workspaces:[
    {workspace:'C:/private/MJobs',changed_count:3,changed_files:['secret.txt']},
    {workspace:'C:/private/worktree',changed_count:null,changed_files:[]},
    {workspace:'C:/private/clean',changed_count:0,changed_files:[]}
  ],coverage:{partial:true,notes:['private diagnostic']},
  arbitrary:'must not pass through'};

function create(fetcher,{maxAgeSeconds=30,clock=()=>now,originUrl='http://127.0.0.1:8765'}={}){
  return createProjectDesktopActivity({projectId:'mjobs',originUrl,maxAgeSeconds,fetcher,clock});
}

test('projects only aggregate counts and safe timestamps from loopback observer',async()=>{
  const calls=[];
  const activity=create(async(url,options)=>{
    calls.push({url,options});
    return new Response(JSON.stringify(source),{status:200,headers:{'content-type':'application/json'}});
  });
  const result=await activity.snapshot();
  assert.deepEqual(calls.map(call=>call.url),['http://127.0.0.1:8765/api/sprints/active']);
  assert.equal(calls[0].options.method,'GET');
  assert.equal(calls[0].options.redirect,'error');
  assert.equal(calls[0].options.cache,'no-store');
  assert.equal(result.project_id,'mjobs');
  assert.equal(result.source,'codex-desktop-loopback-observer');
  assert.equal(result.observed_at,observedAt);
  assert.equal(result.latest_activity_utc,'2026-11-23T17:59:42.000Z');
  assert.equal(result.age_seconds,10);
  assert.equal(result.max_age_seconds,30);
  assert.equal(result.status,'fresh');
  assert.equal(result.coverage_partial,true);
  assert.deepEqual(result.counts,{session_count:2,active_process_count:2,workspace_count:3,
    changed_workspace_count:1,changed_file_count:3,workspace_status_unavailable_count:1});
  const json=JSON.stringify(result);
  for(const forbidden of ['private-session-id','another-id','C:/private','Private Name',
    'private-model','secret.txt','private diagnostic','500','100','must not pass through'])
    assert.equal(json.includes(forbidden),false,forbidden);
});

test('fresh empty observation is zero while a failed first read is unavailable',async()=>{
  const empty={available:true,read_only:true,observed_at:observedAt,latest_activity_utc:null,
    pids:[],sessions:[],workspaces:[],coverage:{partial:false}};
  const fresh=await create(async()=>Response.json(empty)).snapshot();
  assert.equal(fresh.status,'fresh');
  assert.deepEqual(fresh.counts,{session_count:0,active_process_count:0,workspace_count:0,
    changed_workspace_count:0,changed_file_count:0,workspace_status_unavailable_count:0});
  const unavailable=await create(async()=>{throw Error('private error');}).snapshot();
  assert.equal(unavailable.status,'unavailable');
  assert.equal(unavailable.project_id,'mjobs');
  assert.equal(unavailable.counts,undefined);
  assert.equal(JSON.stringify(unavailable).includes('private error'),false);
});

test('read failure keeps last good values and marks them stale',async()=>{
  let fail=false;
  const activity=create(async()=>{
    if(fail)throw Error('do not expose me');
    return Response.json(source);
  });
  const first=await activity.snapshot();
  fail=true;
  const second=await activity.snapshot();
  assert.equal(second.status,'stale');
  assert.deepEqual(second.counts,first.counts);
  assert.equal(second.observed_at,first.observed_at);
  assert.equal(second.age_seconds,10);
  assert.equal(JSON.stringify(second).includes('do not expose me'),false);
});

test('old upstream sample is stale and never replaces last-good sample',async()=>{
  const old={...source,observed_at:'2026-11-23T17:58:00.000Z'};
  let payload=source;
  const activity=create(async()=>Response.json(payload),{maxAgeSeconds:30});
  const first=await activity.snapshot();
  payload=old;
  const second=await activity.snapshot();
  assert.equal(second.status,'stale');
  assert.equal(second.observed_at,first.observed_at);
  assert.deepEqual(second.counts,first.counts);
  const initiallyStale=await create(async()=>Response.json(old),{maxAgeSeconds:30}).snapshot();
  assert.equal(initiallyStale.status,'stale');
  assert.equal(initiallyStale.age_seconds,120);
  assert.equal(initiallyStale.counts.session_count,2);
});

test('rejects non-loopback, credentialed, or non-origin upstream URLs',()=>{
  for(const originUrl of ['https://example.com','http://127.0.0.1:8765/private',
    'http://user:password@127.0.0.1:8765','http://127.0.0.1:8765?x=1'])
    assert.throws(()=>create(async()=>{}, {originUrl}),/loopback origin/i,originUrl);
});

test('malformed and non-read-only observer payloads do not become counts',async()=>{
  for(const payload of [null,{}, {...source,read_only:false}, {...source,observed_at:'bad'},
    {...source,sessions:'not-an-array'}, {...source,coverage:{partial:'false'}}]){
    const result=await create(async()=>Response.json(payload)).snapshot();
    assert.equal(result.status,'unavailable');
    assert.equal(result.counts,undefined);
  }
});
