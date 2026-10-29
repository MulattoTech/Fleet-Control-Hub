'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createAdapters,loopbackEndpoint}=require('../src/adapters');
const {readMJobsProgress,babyProgress,mjobsLifecycle,mjobsPipeline,readMJobsReviewCandidates}=require('../src/progress');
const {makeServer}=require('../src/server');
const {configuredRemote}=require('../src/remote-auth');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const http=require('node:http');

function fixture(){const calls=[];const fetcher=async(url,options={})=>{calls.push({url,options});
  if(url.endsWith('/api/state')&&url.includes(':8787'))return {ok:true,json:async()=>({projectId:'mjobs-luna',sessions:[{id:'a'}],summary:{total:1,working:0,idle:1,idlePending:0,ciAttention:0}})};
  if(url.endsWith('/api/master'))return {ok:true,json:async()=>({dispatch:{sustainedEnabled:false,turboEnabled:false},emergency:{latched:false},drain:{enabled:true}})};
  if(url.endsWith('/api/sustain'))return {ok:true,json:async()=>({workItems:[{state:'approved'},{state:'leased'}],artifactReviews:{ready:1}})};
  if(url.endsWith('/api/run'))return {ok:true,json:async()=>({projectId:'mjobs-luna',phase:'idle',active:false,running:false,primaryId:'mjobs-luna-40',quota:{fresh:true,remainingPercent:46,minimumRemainingPercent:0,blocked:false},blockedReasons:[]})};
  if(url.endsWith('/api/startup'))return {ok:true,json:async()=>({run:{phase:'idle',active:false},preview:{targetCount:2,projectIds:['mjobs-luna'],primaryIds:['mjobs-luna-40'],manifestRevision:'a'.repeat(64)}})};
  if(url.endsWith('/api/startup/mjobs-preview'))return {ok:true,json:async()=>({projectId:'mjobs-luna',targetCount:2,primaryIds:['mjobs-luna-40'],manifestRevision:'a'.repeat(64),scopedStartSupported:true})};
  if(url.endsWith('/api/quota'))return {ok:true,json:async()=>({fresh:true,policy:{blocked:false,remainingPercent:46}})};
  if(url.endsWith('/api/state')&&url.includes(':4319'))return {ok:true,json:async()=>({projectId:'babytracker',sessions:[{id:'b'}],runtime:{online:true},mode:'paused',tasks:[],summary:{total:1,working:0,available:1,blocked:0},acceptance:{status:'NOT_ASSESSED'},quota:{fresh:true,remainingPercent:46},quotaPolicy:{minimumAllowedPercent:15}})};
  if(url.endsWith('/api/session'))return {ok:true,json:async()=>({token:'x'.repeat(64)})};
  if(options.method==='POST')return {ok:true,json:async()=>({ok:true})};
  throw Error('Unexpected URL: '+url);
};return {calls,fetcher};}

test('only fixed loopback controller origins are allowed',()=>{
  for(const value of ['http://example.com/','https://127.0.0.1:8787/','http://127.0.0.1:8787/path','http://user@127.0.0.1:8787/'])assert.throws(()=>loopbackEndpoint(value));
  assert.equal(loopbackEndpoint('http://localhost:8787/'),'http://localhost:8787');
});

test('project-specific limits require paused controllers, exact revision and native read-back',async()=>{
  const calls=[];let baby={concurrency:1,maxDispatches:1,maxMinutes:5},sustain={targetWorking:12,maxDispatchPerTick:2},turbo={targetWorking:8,maxActionsPerCycle:2,maxActionsPerHour:10};
  let babyActive=false,mjobsEnabled=false;
  const fetcher=async(url,options={})=>{calls.push({url,options});
    if(options.method==='POST'){
      const body=JSON.parse(options.body);
      if(url.endsWith('/api/action'))baby={...baby,...body.limits};
      if(url.endsWith('/api/sustain/config'))sustain={...sustain,...body};
      if(url.endsWith('/api/turbo/config'))turbo={...turbo,...body};
      return {ok:true,json:async()=>({ok:true})};
    }
    if(url.endsWith('/api/state'))return {ok:true,json:async()=>({projectId:'babytracker',mode:'paused',summary:{working:0},sessions:[{runtimeActive:babyActive}],limits:baby})};
    if(url.endsWith('/api/master'))return {ok:true,json:async()=>({dispatch:{sustainedEnabled:mjobsEnabled,turboEnabled:false}})};
    if(url.endsWith('/api/startup'))return {ok:true,json:async()=>({run:{active:false}})};
    if(url.endsWith('/api/sustain'))return {ok:true,json:async()=>({config:sustain})};
    if(url.endsWith('/api/turbo'))return {ok:true,json:async()=>({config:turbo})};
    if(url.endsWith('/api/session'))return {ok:true,json:async()=>({token:'x'.repeat(64)})};
    throw Error('Unexpected read');
  };
  const api=createAdapters({fetcher});
  const first=await api.limits('babytracker');assert.equal(first.editable,true);
  await assert.rejects(api.saveLimits('babytracker','run',{concurrency:10,maxDispatches:8,maxMinutes:60},first.profiles[0].values,'wrong'),/confirmation/);
  assert.equal(calls.filter(c=>c.options.method==='POST').length,0);
  babyActive=true;await assert.rejects(api.saveLimits('babytracker','run',{concurrency:10,maxDispatches:8,maxMinutes:60},first.profiles[0].values,'SAVE babytracker run'),/Pause and exit/);
  babyActive=false;baby.maxMinutes=6;await assert.rejects(api.saveLimits('babytracker','run',{concurrency:10,maxDispatches:8,maxMinutes:60},first.profiles[0].values,'SAVE babytracker run'),/changed since preview/);
  const current=(await api.limits('babytracker')).profiles[0];await api.saveLimits('babytracker','run',{concurrency:10,maxDispatches:8,maxMinutes:60},current.values,'SAVE babytracker run');
  assert.equal(calls.filter(c=>c.options.method==='POST').at(-1).url,'http://127.0.0.1:4319/api/action');assert.equal(calls.filter(c=>c.options.method==='POST').at(-1).options.headers['x-babytracker-fleet'],'x'.repeat(64));
  const mjobs=(await api.limits('mjobs')).profiles[0];mjobsEnabled=true;
  await assert.rejects(api.saveLimits('mjobs','sustain',{targetWorking:13,maxDispatchPerTick:2},mjobs.values,'SAVE mjobs sustain'),/Pause MJobs/);
  mjobsEnabled=false;await api.saveLimits('mjobs','sustain',{targetWorking:13,maxDispatchPerTick:2},mjobs.values,'SAVE mjobs sustain');
  assert.equal(calls.filter(c=>c.options.method==='POST').at(-1).url,'http://127.0.0.1:8787/api/sustain/config');assert.equal(calls.filter(c=>c.options.method==='POST').at(-1).options.headers['x-ao-fleet'],'1');
  assert.equal((await api.limits('mjobs')).profiles[1].values.maxActionsPerHour,10);
});

test('limits HTTP write requires same origin and action token',async()=>{
  const calls=[];const server=makeServer({port:4325,adapters:{limits:async id=>({id,profiles:[]}),saveLimits:async(...args)=>{calls.push(args);return {ok:true,note:'verified'};}}});
  await new Promise(resolve=>server.listen(4325,'127.0.0.1',resolve));
  try{const base='http://127.0.0.1:4325',body=JSON.stringify({id:'babytracker',profile:'run',values:{concurrency:1},expected:{concurrency:1},confirmation:'SAVE babytracker run'});
    assert.equal((await fetch(base+'/api/limits?id=babytracker')).status,200);
    const token=(await (await fetch(base+'/api/session')).json()).token;
    const send=(origin,actionToken)=>fetch(base+'/api/limits',{method:'POST',headers:{origin,'content-type':'application/json','x-fleet-hub':actionToken},body});
    assert.equal((await send(base,'wrong')).status,403);
    assert.equal((await send('http://evil.example',token)).status,403);
    assert.equal(calls.length,0);
    assert.equal((await send(base,token)).status,200);
    assert.deepEqual(calls[0],['babytracker','run',{concurrency:1},{concurrency:1},'SAVE babytracker run']);
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test('bounded MJobs web Start, Pause and Stop flow is project scoped in an isolated controller fixture',async()=>{
  const operations=[];let mode='paused';let active=false;
  const adapters={
    startPreview:async id=>{assert.equal(id,'mjobs');return {id,targetCount:1,confirmation:'START MJobs',manifestRevision:'a'.repeat(64),blocked:false,quotaFresh:true};},
    start:async(id,confirmation,requestId,revision)=>{assert.equal(id,'mjobs');assert.equal(confirmation,'START MJobs');assert.equal(requestId,'fixture-start-1');assert.equal(revision,'a'.repeat(64));if(active)throw Error('Already active');active=true;mode='running';operations.push('mjobs:start');return {ok:true,note:'fixture start'};},
    control:async(id,action)=>{assert.equal(id,'mjobs');operations.push('mjobs:'+action);if(action==='pause')mode='paused';if(action==='graceful-stop'){active=false;mode='drained';}return {ok:true,note:'fixture '+action};},
    status:async id=>({id,mode,working:active?1:0,total:id==='mjobs'?1:0})
  };
  const server=makeServer({port:4326,adapters});await new Promise(resolve=>server.listen(4326,'127.0.0.1',resolve));
  try{const base='http://127.0.0.1:4326',token=(await (await fetch(base+'/api/session')).json()).token;
    const post=(path,body)=>fetch(base+path,{method:'POST',headers:{origin:base,'content-type':'application/json','x-fleet-hub':token},body:JSON.stringify(body)});
    const preview=await (await fetch(base+'/api/start-preview?id=mjobs')).json();assert.equal(preview.targetCount,1);
    assert.equal((await post('/api/start',{id:'mjobs',confirmation:preview.confirmation,requestId:'fixture-start-1',manifestRevision:preview.manifestRevision})).status,202);
    assert.equal((await (await fetch(base+'/api/status')).json()).fleets[0].working,1);
    assert.equal((await post('/api/control',{id:'mjobs',action:'pause'})).status,200);
    assert.equal((await post('/api/control',{id:'mjobs',action:'graceful-stop'})).status,200);
    assert.equal((await (await fetch(base+'/api/status')).json()).fleets[0].working,0);
    assert.deepEqual(operations,['mjobs:start','mjobs:pause','mjobs:graceful-stop']);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
test('Hub Start HTTP errors retain the distinction between transport uncertainty and definitive refusal',async()=>{
  let definitive=false;
  const server=makeServer({port:4328,adapters:{start:async()=>{throw Object.assign(Error('native failed'),{definitive});}}});
  await new Promise(resolve=>server.listen(4328,'127.0.0.1',resolve));
  try{
    const base='http://127.0.0.1:4328',token=(await (await fetch(base+'/api/session')).json()).token;
    const send=()=>fetch(base+'/api/start',{method:'POST',headers:{origin:base,'content-type':'application/json','x-fleet-hub':token},body:JSON.stringify({id:'mjobs',confirmation:'START MJobs',requestId:'stable-123'})});
    let response=await send();assert.equal(response.status,502);assert.equal((await response.json()).definitive,false);
    definitive=true;response=await send();assert.equal(response.status,502);assert.equal((await response.json()).definitive,true);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
test('one-session MJobs start binds the exact saved primary and keeps dispatch off',async()=>{
  const calls=[];let babyChanged=false;
  const fetcher=async(url,options={})=>{calls.push({url,options});
    if(options.method==='POST')return {ok:true,json:async()=>({ok:true})};
    if(url.endsWith('/api/startup/mjobs-bounded-preview'))return {ok:true,json:async()=>({projectId:'mjobs-luna',boundedStartSupported:true,dispatchAfter:false,targetCount:1,primaryId:'mjobs-luna-40',manifestRevision:(babyChanged?'b':'a').repeat(64)})};
    if(url.endsWith('/api/state'))return {ok:true,json:async()=>({projectId:'mjobs-luna',sessions:[{status:'exited',activity:'exited'}]})};
    if(url.endsWith('/api/master'))return {ok:true,json:async()=>({dispatch:{sustainedEnabled:false,turboEnabled:false},emergency:{latched:false},drain:{enabled:false}})};
    if(url.endsWith('/api/startup'))return {ok:true,json:async()=>({run:{phase:'idle',active:false}})};
    if(url.endsWith('/api/quota'))return {ok:true,json:async()=>({fresh:true,policy:{blocked:false,remainingPercent:37}})};
    throw Error('Unexpected read: '+url);
  };
  const api=createAdapters({fetcher}),preview=await api.boundedStartPreview('mjobs');
  assert.equal(preview.blocked,false);assert.equal(preview.targetCount,1);
  await assert.rejects(api.boundedStart('mjobs','START ONE MJobs','fixture-123',preview.manifestRevision,'mjobs-luna-5'),/binding/);
  babyChanged=true;await assert.rejects(api.boundedStart('mjobs','START ONE MJobs','fixture-123',preview.manifestRevision,preview.primaryId),/binding/);
  babyChanged=false;await api.boundedStart('mjobs','START ONE MJobs','fixture-123',preview.manifestRevision,preview.primaryId);
  const posts=calls.filter(c=>c.options.method==='POST');assert.equal(posts.length,1);
  assert.deepEqual(JSON.parse(posts[0].options.body),{confirm:'STARTUP',requestId:'fixture-123',openUi:false,startWorkAfter:false,expectedProjectId:'mjobs-luna',expectedManifestRevision:'a'.repeat(64),boundedPrimaryId:'mjobs-luna-40'});
});
test('one-session HTTP write requires same origin and action token',async()=>{
  const calls=[];const server=makeServer({port:4327,adapters:{boundedStartPreview:async()=>({targetCount:1}),boundedStart:async(...args)=>{calls.push(args);return {ok:true}}}});
  await new Promise(resolve=>server.listen(4327,'127.0.0.1',resolve));
  try{const base='http://127.0.0.1:4327',body=JSON.stringify({id:'mjobs',confirmation:'START ONE MJobs',requestId:'fixture-123',manifestRevision:'a'.repeat(64),primaryId:'mjobs-luna-40'});
    assert.equal((await fetch(base+'/api/bounded-start-preview?id=mjobs')).status,200);
    const token=(await (await fetch(base+'/api/session')).json()).token;
    const send=(origin,actionToken)=>fetch(base+'/api/bounded-start',{method:'POST',headers:{origin,'content-type':'application/json','x-fleet-hub':actionToken},body});
    assert.equal((await send(base,'bad')).status,403);assert.equal((await send('http://evil.example',token)).status,403);assert.equal(calls.length,0);
    assert.equal((await send(base,token)).status,202);assert.deepEqual(calls[0],['mjobs','START ONE MJobs','fixture-123','a'.repeat(64),'mjobs-luna-40']);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
test('status reads normalize both fleets and never mutate',async()=>{
  const {calls,fetcher}=fixture();const api=createAdapters({fetcher});
  assert.equal((await api.status('mjobs')).total,1);assert.equal((await api.status('babytracker')).review,'NOT_ASSESSED');
  assert.deepEqual((await api.status('mjobs')).safety,{dispatchEnabled:false,emergency:false,emergencyScope:'machine',gracefulStop:true,codexQuotaFresh:true,codexRemaining:46});
  assert.equal((await api.status('babytracker')).safety.emergencyScope,'project');
  assert.ok(calls.every(x=>!x.options.method||x.options.method==='GET'));
});
test('MJobs status projects native run progress and errors while preserving observed worker counts',async()=>{
  const {fetcher}=fixture();let run={projectId:'mjobs-luna',phase:'starting',active:true,running:false};
  const api=createAdapters({fetcher:async(url,options)=>{if(url.endsWith('/api/run')){if(!run)throw Error('Older controller');return {ok:true,json:async()=>run};}return fetcher(url,options);},progressReader:()=>({available:false})});
  let status=await api.status('mjobs');assert.equal(status.mode,'starting');assert.equal(status.working,0);assert.equal(status.total,1);
  run={projectId:'mjobs-luna',phase:'blocked',active:false,running:false,error:'Fresh Codex sample unavailable'};
  status=await api.status('mjobs');assert.equal(status.mode,'blocked');assert.equal(status.detail,'Fresh Codex sample unavailable');assert.equal(status.working,0);
  run={projectId:'mjobs-luna',phase:'running',active:false,running:true};assert.equal((await api.status('mjobs')).mode,'running');
  run=null;assert.equal((await api.status('mjobs')).mode,'paused or manual');
});
test('Start preview preserves native reconciliation blockers without requiring a completed stop to be rearmed',async()=>{
  const {fetcher}=fixture();
  const api=createAdapters({fetcher:async(url,options)=>{
    if(url.endsWith('/api/run'))return {ok:true,json:async()=>({projectId:'mjobs-luna',phase:'uncertain',quota:{fresh:true,remainingPercent:46},blockedReasons:['Native delivery requires reconciliation']})};
    if(url.includes(':4319')&&url.endsWith('/api/state'))return {ok:true,json:async()=>({projectId:'babytracker',mode:'draining',bootstrap:{status:'uncertain'},quota:{fresh:true,remainingPercent:46},summary:{total:1},sessions:[],tasks:[]})};
    return fetcher(url,options);
  }});
  assert.match((await api.startPreview('mjobs')).blockedReasons.join(' '),/delivery requires reconciliation/);
  const baby=await api.startPreview('babytracker');
  assert.doesNotMatch(baby.blockedReasons.join(' '),/draining sessions/);
  assert.match(baby.blockedReasons.join(' '),/bootstrap needs native reconciliation/);
});
test('MJobs uncertain spawn or resume may be verified by native Start while unknown delivery stays blocked',async()=>{
  const {calls,fetcher}=fixture();let pending={kind:'spawn'},blockedReasons=[];
  const api=createAdapters({fetcher:async(url,options)=>url.endsWith('/api/run')?{ok:true,json:async()=>({projectId:'mjobs-luna',phase:'uncertain',pending,quota:{fresh:true,remainingPercent:46,minimumRemainingPercent:0,blocked:false},blockedReasons})}:fetcher(url,options)});
  for(const kind of ['spawn','resume']){
    pending={kind};assert.equal((await api.startPreview('mjobs')).blocked,false);
    await api.start('mjobs','START MJobs','verify-'+kind);
  }
  for(const value of [null,{kind:'send'},{kind:'unknown'}]){
    pending=value;assert.equal((await api.startPreview('mjobs')).blocked,true);
    await assert.rejects(api.start('mjobs','START MJobs','verify-unknown'),/reconciliation/);
  }
  pending={kind:'spawn'};blockedReasons=['Run state is unreadable'];assert.equal((await api.startPreview('mjobs')).blocked,true);
  await assert.rejects(api.start('mjobs','START MJobs','verify-unreadable'),/unreadable/);
  assert.equal(calls.filter(c=>c.options.method==='POST').length,2);
});
test('MJobs normal Start validates project identity and never reads the saved restore manifest',async()=>{
  const {calls,fetcher}=fixture();
  const api=createAdapters({fetcher:async(url,options)=>url.endsWith('/api/run')?{ok:true,json:async()=>({projectId:'babytracker'})}:fetcher(url,options)});
  await assert.rejects(api.startPreview('mjobs'),/identity changed/);
  await assert.rejects(api.start('mjobs','START MJobs','stable-123'),/identity changed/);
  assert.equal(calls.filter(x=>x.options.method==='POST').length,0);
  const valid=createAdapters({fetcher});assert.equal((await valid.startPreview('mjobs')).blocked,false);
  assert.equal(calls.some(c=>c.url.includes('/api/startup')),false);
});
test('MJobs zero reserve allows one percent, blocks provider exhaustion and delegates stale refresh to native Start',async()=>{
  const {calls,fetcher}=fixture();let fresh=true,remainingPercent=1,blocked=false;
  const api=createAdapters({fetcher:async(url,options)=>url.endsWith('/api/run')?{ok:true,json:async()=>({projectId:'mjobs-luna',phase:'paused',quota:{fresh,remainingPercent,minimumRemainingPercent:0,blocked},blockedReasons:[]})}:fetcher(url,options)});
  assert.equal((await api.startPreview('mjobs')).blocked,false);
  await api.start('mjobs','START MJobs','stable-123');
  remainingPercent=0;assert.equal((await api.startPreview('mjobs')).blocked,true);
  await assert.rejects(api.start('mjobs','START MJobs','stable-124'),/quota/);
  fresh=false;remainingPercent=null;blocked=true;
  const stale=await api.startPreview('mjobs');assert.equal(stale.quotaFresh,false);assert.equal(stale.blocked,false);
  await api.start('mjobs','START MJobs','stable-125');
  assert.equal(calls.filter(c=>c.options.method==='POST').length,2);
});
test('pause targets only the selected controller',async()=>{
  const {calls,fetcher}=fixture();const api=createAdapters({fetcher});
  await api.pause('babytracker');assert.equal(calls.filter(x=>x.options.method==='POST').length,1);
  assert.equal(calls.at(-1).url,'http://127.0.0.1:4319/api/action');
  assert.equal(JSON.parse(calls.at(-1).options.body).action,'pause');
  assert.equal(calls.at(-1).options.headers['x-babytracker-fleet'],'x'.repeat(64));
  await api.pause('mjobs');assert.equal(calls.at(-1).url,'http://127.0.0.1:8787/api/master/pause');
  assert.equal(calls.at(-1).options.headers['x-ao-fleet'],'1');
  await assert.rejects(api.pause('other'));
  await api.control('mjobs','graceful-stop');assert.equal(calls.at(-1).url,'http://127.0.0.1:8787/api/master/drain');
  assert.equal(JSON.parse(calls.at(-1).options.body).confirm,'GRACEFUL STOP');
  await api.control('babytracker','graceful-stop');assert.equal(JSON.parse(calls.at(-1).options.body).action,'drain');
  await assert.rejects(api.control('babytracker','start'));
});
test('Start uses native simple run routes, stable request IDs and project action authentication',async()=>{
  const {calls,fetcher}=fixture();const api=createAdapters({fetcher,progressReader:()=>({available:false})});
  assert.equal((await api.startPreview('mjobs')).targetCount,1);
  await assert.rejects(api.start('mjobs','wrong','stable-123'));
  await assert.rejects(api.start('mjobs','START MJobs','bad'),/Stable request ID/);
  assert.equal(calls.filter(x=>x.options.method==='POST').length,0);
  await api.start('mjobs','START MJobs','stable-123');
  assert.equal(calls.at(-1).url,'http://127.0.0.1:8787/api/run/start');
  assert.deepEqual(JSON.parse(calls.at(-1).options.body),{requestId:'stable-123'});
  assert.equal(calls.at(-1).options.headers['x-ao-fleet'],'1');
  assert.equal(calls.at(-1).options.headers.origin,'http://127.0.0.1:8787');
  await assert.rejects(api.start('babytracker','wrong','stable-124'));
  await api.start('babytracker','START BabyTracker','stable-124');
  assert.deepEqual(JSON.parse(calls.at(-1).options.body),{action:'simpleStart',requestId:'stable-124'});
  assert.equal(calls.at(-1).options.headers['x-babytracker-fleet'],'x'.repeat(64));
});
test('BabyTracker uses a saved zero reserve and leaves running, stop recovery and real pending checks to native Start',async()=>{
  const {fetcher}=fixture();let mode='emergency',remainingPercent=1,fresh=true,bootstrap;
  const api=createAdapters({fetcher:async(url,options)=>url.endsWith('/api/state')?{ok:true,json:async()=>({projectId:'babytracker',mode,bootstrap,quota:{fresh,remainingPercent},quotaPolicy:{minimumAllowedPercent:0}})}:fetcher(url,options)});
  for(mode of ['emergency','draining','running','paused']){assert.equal((await api.startPreview('babytracker')).blocked,false);await api.start('babytracker','START BabyTracker','stable-123');}
  remainingPercent=0;assert.equal((await api.startPreview('babytracker')).blocked,true);
  remainingPercent=1;fresh=false;assert.equal((await api.startPreview('babytracker')).blocked,true);
  fresh=true;bootstrap={status:'uncertain'};assert.equal((await api.startPreview('babytracker')).blocked,true);
});
test('Hub Start distinguishes native transport uncertainty from a parsed controller refusal',async()=>{
  const {fetcher}=fixture();let refusal=false;
  const api=createAdapters({fetcher:async(url,options)=>{if(url.endsWith('/api/run/start')){if(!refusal)throw Error('native response lost');return {ok:false,json:async()=>({error:'native quota hold'})};}return fetcher(url,options);}});
  await assert.rejects(api.start('mjobs','START MJobs','stable-123'),e=>e.message==='native response lost'&&e.definitive!==true);
  refusal=true;await assert.rejects(api.start('mjobs','START MJobs','stable-123'),e=>e.message==='native quota hold'&&e.definitive===true);
});
test('progress summaries contain counts only and preserve unknown evidence',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-hub-test-'));
  try{
    fs.writeFileSync(path.join(dir,'artifact-review-state.json'),JSON.stringify({version:1,tasks:{a:{state:'review_ready',acceptance:'unassessed'},b:{state:'uncertain'}}}));
    fs.writeFileSync(path.join(dir,'productive-work-state.json'),JSON.stringify({version:1,tasks:{c:{state:'artifact_ready',acceptance:'unreviewed'}}}));
    assert.deepEqual(readMJobsProgress(dir),{available:true,reviews:{total:2,ready:1,inFlight:1,unassessed:1},reviewDecisions:{available:true,awaitingAssessment:1,accepted:0,revisionRequested:0,rejected:0},drafts:{total:1,ready:1,inFlight:0,unreviewed:1}});
    assert.deepEqual(babyProgress({tasks:[{title:'private',status:'proposed',acceptance:'NOT_ASSESSED'}]}),{available:true,tasks:{total:1,proposed:1,inFlight:0,accepted:0,unassessed:1},reviewDecisions:{available:true,awaitingAssessment:1,accepted:null,revisionRequested:null,rejected:null},pipeline:{available:true,proposed:1,approved:null,active:0,completed:0,accepted:0,blocked:0,unassessed:1}});
    assert.deepEqual(mjobsLifecycle({workItems:[{issue:7,state:'approved'},{issue:9,state:'completed'}],artifactReviews:{ready:1}}),{available:true,approved:1,leased:0,completed:1,reviewReady:1});
    assert.deepEqual(readMJobsProgress(path.join(dir,'missing')),{available:false});
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('shared work stages count native states without claiming unsupported parity or exposing task text',()=>{
  const native={workItems:[{issue:1,state:'approved',focus:'private text'},{issue:2,state:'dispatched',focus:'private text'},{issue:3,state:'in_review'},{issue:4,state:'completed'}]};
  const mjobs=mjobsPipeline(mjobsLifecycle(native),{available:false});
  const baby=babyProgress({tasks:[{status:'proposed',title:'private family data',acceptance:'NOT_ASSESSED'},
    {status:'submitted',title:'private family data',acceptance:'NOT_ASSESSED'},{status:'completed',title:'private family data',acceptance:'NOT_ASSESSED'},
    {status:'accepted',title:'private family data',acceptance:'ACCEPTED'},{status:'blocked',title:'private family data',acceptance:'NOT_ASSESSED'}]}).pipeline;
  assert.deepEqual(mjobs,{available:true,proposed:null,approved:1,active:2,completed:1,accepted:null,blocked:null,unassessed:null});
  assert.deepEqual(baby,{available:true,proposed:1,approved:null,active:1,completed:1,accepted:1,blocked:1,unassessed:4});
  assert.equal(JSON.stringify({mjobs,baby}).includes('private'),false);
});
test('review receipts are summarized without evidence text or unsupported decisions',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-review-test-'));
  try{
    fs.writeFileSync(path.join(dir,'artifact-review-state.json'),JSON.stringify({version:1,tasks:{a:{state:'review_ready',acceptance:'accepted',finding:'private review text'},b:{state:'review_ready',acceptance:'revision_requested'},c:{state:'review_ready',acceptance:'rejected'}}}));
    fs.writeFileSync(path.join(dir,'productive-work-state.json'),JSON.stringify({version:1,tasks:{}}));
    const mjobs=readMJobsProgress(dir).reviewDecisions;
    const baby=babyProgress({tasks:[{acceptance:'NOT_ASSESSED',title:'private family text'},{acceptance:'ACCEPTED',title:'private family text'}]}).reviewDecisions;
    assert.deepEqual(mjobs,{available:true,awaitingAssessment:0,accepted:1,revisionRequested:1,rejected:1});
    assert.deepEqual(baby,{available:true,awaitingAssessment:1,accepted:null,revisionRequested:null,rejected:null});
    const upgraded=babyProgress({capabilities:{reviewAssessment:true},tasks:[{acceptance:'NOT_ASSESSED',title:'private'},{acceptance:'ACCEPTED',title:'private'},{acceptance:'REVISION_REQUESTED',title:'private'},{acceptance:'REJECTED',title:'private'}]}).reviewDecisions;
    assert.deepEqual(upgraded,{available:true,awaitingAssessment:1,accepted:1,revisionRequested:1,rejected:1});
    assert.equal(JSON.stringify(upgraded).includes('private'),false);
    assert.equal(JSON.stringify({mjobs,baby}).includes('private'),false);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('review candidates expose bounded IDs and outcomes without evidence or task text',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-candidates-'));
  try{
    const key='artifact-review:v2:'+'a'.repeat(40)+':1';
    fs.writeFileSync(path.join(dir,'artifact-review-state.json'),JSON.stringify({version:1,tasks:{[key]:{state:'review_ready',acceptance:'unassessed',outcome:'useful',sourcePath:'private/path',findings:'private findings'},other:{state:'review_ready',acceptance:'unassessed'}}}));
    const candidates=readMJobsReviewCandidates({root:dir});
    assert.deepEqual(candidates,{supported:true,total:1,offset:0,candidates:[{id:key,outcome:'useful'}]});
    assert.equal(JSON.stringify(candidates).includes('private'),false);
    assert.equal(readMJobsReviewCandidates({root:dir,offset:1}).candidates.length,0);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('one assessment interface binds each controller and refuses BabyTracker before native capability',async()=>{
  const {calls,fetcher}=fixture(),key='artifact-review:v2:'+'a'.repeat(40)+':1';
  const reviewReader=({offset=0,limit=50}={})=>({supported:true,total:1,offset,candidates:[{id:key,outcome:'useful'}].slice(offset,offset+limit)});
  const api=createAdapters({fetcher,reviewReader});
  assert.equal((await api.reviewCandidates('mjobs')).candidates[0].id,key);
  await assert.rejects(api.assessReview('mjobs',key,'accepted','wrong',true),/confirmation/);
  await assert.rejects(api.assessReview('mjobs',key,'accepted','ASSESS MJobs',false),/confirmation/);
  await assert.rejects(api.assessReview('mjobs','unknown','accepted','ASSESS MJobs',true),/unavailable/);
  await assert.rejects(api.assessReview('babytracker','task-1','accepted','ASSESS BabyTracker',true,48,101),/unavailable/);
  assert.equal(calls.filter(x=>x.options.method==='POST').length,0);
  await api.assessReview('mjobs',key,'accepted','ASSESS MJobs',true);
  assert.equal(calls.at(-1).url,'http://127.0.0.1:8787/api/sustain/assess-review');
  assert.deepEqual(JSON.parse(calls.at(-1).options.body),{key,decision:'accepted'});
  assert.equal(calls.at(-1).options.headers['x-ao-fleet'],'1');
  const supported=createAdapters({reviewReader,fetcher:async(url,options)=>{
    if(url.includes(':4319')&&url.endsWith('/api/state'))return {ok:true,json:async()=>({projectId:'babytracker',capabilities:{reviewAssessment:true},tasks:[{id:'a'.repeat(8)+'-aaaa-aaaa-aaaa-'+'a'.repeat(12),issue:47,status:'submitted',title:'private'}]})};
    return fetcher(url,options);
  }});
  const id='a'.repeat(8)+'-aaaa-aaaa-aaaa-'+'a'.repeat(12);
  assert.equal(JSON.stringify(await supported.reviewCandidates('babytracker')).includes('private'),false);
  await supported.assessReview('babytracker',id,'revision_requested','ASSESS BabyTracker',true,48,101);
  assert.equal(calls.at(-1).url,'http://127.0.0.1:4319/api/action');
  assert.deepEqual(JSON.parse(calls.at(-1).options.body),{action:'assess-task',taskId:id,decision:'revision_requested',prNumber:48,reviewId:101,confirm:'ASSESS BabyTracker'});
});
test('local hub rejects cross-origin actions and needs an action token',async()=>{
  const {fetcher}=fixture();const server=makeServer({adapters:createAdapters({fetcher}),port:4322});
  await new Promise(resolve=>server.listen(4322,'127.0.0.1',resolve));
  try{
    const base='http://127.0.0.1:4322';
    const status=await fetch(base+'/api/status');assert.equal(status.status,200);
    const denied=await fetch(base+'/api/pause',{method:'POST',headers:{origin:'http://evil.test','content-type':'application/json'},body:'{"id":"mjobs"}'});assert.equal(denied.status,403);
    const token=(await (await fetch(base+'/api/session')).json()).token;
    const paused=await fetch(base+'/api/pause',{method:'POST',headers:{origin:base,'content-type':'application/json','x-fleet-hub':token},body:'{"id":"mjobs"}'});assert.equal(paused.status,200);
    const bad=await fetch(base+'/api/control',{method:'POST',headers:{origin:base,'content-type':'application/json','x-fleet-hub':token},body:'{"id":"mjobs","action":"start"}'});assert.equal(bad.status,400);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
test('review HTTP route requires action token and exact assessment confirmation',async()=>{
  const {calls,fetcher}=fixture(),key='artifact-review:v2:'+'a'.repeat(40)+':1';
  const adapters=createAdapters({fetcher,reviewReader:({offset=0}={})=>({supported:true,total:1,offset,candidates:[{id:key,outcome:'useful'}]})});
  const server=makeServer({adapters,port:4324});await new Promise(resolve=>server.listen(4324,'127.0.0.1',resolve));
  try{const base='http://127.0.0.1:4324',candidate=await (await fetch(base+'/api/review-candidates?id=mjobs')).json();
    assert.equal(candidate.candidates[0].id,key);
    const body=JSON.stringify({id:'mjobs',candidateId:key,decision:'accepted',confirmation:'ASSESS MJobs',evidenceReviewed:true});
    const denied=await fetch(base+'/api/review-assessment',{method:'POST',headers:{origin:base,'content-type':'application/json'},body});assert.equal(denied.status,403);
    const token=(await (await fetch(base+'/api/session')).json()).token;
    const wrong=await fetch(base+'/api/review-assessment',{method:'POST',headers:{origin:base,'content-type':'application/json','x-fleet-hub':token},body:JSON.stringify({id:'mjobs',candidateId:key,decision:'accepted',confirmation:'wrong',evidenceReviewed:true})});assert.equal(wrong.status,502);
    assert.equal(calls.filter(x=>x.options.method==='POST').length,0);
    const accepted=await fetch(base+'/api/review-assessment',{method:'POST',headers:{origin:base,'content-type':'application/json','x-fleet-hub':token},body});assert.equal(accepted.status,200);
    assert.equal(calls.filter(x=>x.options.method==='POST').length,1);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
test('remote origin requires complete Access configuration and verified owner assertion',async()=>{
  assert.throws(()=>configuredRemote({FLEET_HUB_REMOTE_HOST:'fleet.m-techlabs.com'}));
  const remote={hostname:'fleet.m-techlabs.com',issuer:'https://example.cloudflareaccess.com',audience:'a'.repeat(64),ownerEmail:'owner@example.test'};
  const {fetcher}=fixture();const server=makeServer({adapters:createAdapters({fetcher}),port:4323,remote,verifyRemote:async token=>{if(token!=='verified')throw Error('denied');return true;}});
  await new Promise(resolve=>server.listen(4323,'127.0.0.1',resolve));
  async function request(headers){return new Promise((resolve,reject)=>{http.get({hostname:'127.0.0.1',port:4323,path:'/api/status',headers},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));}).on('error',reject);});}
  try{
    assert.equal(await request({host:'fleet.m-techlabs.com'}),403);
    assert.equal(await request({host:'fleet.m-techlabs.com','cf-access-jwt-assertion':'wrong'}),403);
    assert.equal(await request({host:'fleet.m-techlabs.com','cf-access-jwt-assertion':'verified'}),200);
    assert.equal(await request({host:'fleet.m-techlabs.com','cf-access-jwt-assertion':'verified','sec-fetch-site':'cross-site'}),200);
    const token=(await (await fetch('http://127.0.0.1:4323/api/session')).json()).token;
    const crossSiteAction=await new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:4323,path:'/api/pause',method:'POST',headers:{host:'fleet.m-techlabs.com',origin:'https://fleet.m-techlabs.com','cf-access-jwt-assertion':'verified','sec-fetch-site':'cross-site','x-fleet-hub':token,'content-type':'application/json'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end(JSON.stringify({id:'mjobs'}));});
    assert.equal(crossSiteAction,403);
    const status=await new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:4323,path:'/api/review-assessment',method:'POST',headers:{host:'fleet.m-techlabs.com',origin:'https://fleet.m-techlabs.com','cf-access-jwt-assertion':'verified','x-fleet-hub':token,'content-type':'application/json'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end(JSON.stringify({id:'mjobs',candidateId:'x',decision:'accepted',confirmation:'ASSESS MJobs',evidenceReviewed:true}));});
    assert.equal(status,403);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
