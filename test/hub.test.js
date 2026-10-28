'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createAdapters,loopbackEndpoint}=require('../src/adapters');
const {readMJobsProgress,babyProgress,mjobsLifecycle}=require('../src/progress');
const {makeServer}=require('../src/server');
const {configuredRemote}=require('../src/remote-auth');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const http=require('node:http');

function fixture(){const calls=[];const fetcher=async(url,options={})=>{calls.push({url,options});
  if(url.endsWith('/api/state')&&url.includes(':8787'))return {ok:true,json:async()=>({projectId:'mjobs-luna',sessions:[{id:'a'}],summary:{total:1,working:0,idle:1,idlePending:0,ciAttention:0}})};
  if(url.endsWith('/api/master'))return {ok:true,json:async()=>({dispatch:{sustainedEnabled:false,turboEnabled:false}})};
  if(url.endsWith('/api/sustain'))return {ok:true,json:async()=>({workItems:[{state:'approved'},{state:'leased'}],artifactReviews:{ready:1}})};
  if(url.endsWith('/api/startup'))return {ok:true,json:async()=>({run:{phase:'idle',active:false},preview:{targetCount:2}})};
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
test('status reads normalize both fleets and never mutate',async()=>{
  const {calls,fetcher}=fixture();const api=createAdapters({fetcher});
  assert.equal((await api.status('mjobs')).total,1);assert.equal((await api.status('babytracker')).review,'NOT_ASSESSED');
  assert.ok(calls.every(x=>!x.options.method||x.options.method==='GET'));
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
test('start requires fresh preview, exact phrase and stable MJobs request ID',async()=>{
  const {calls,fetcher}=fixture();const api=createAdapters({fetcher,progressReader:()=>({available:false})});
  assert.equal((await api.startPreview('mjobs')).targetCount,2);
  await assert.rejects(api.start('mjobs','wrong','stable-123'));
  assert.equal(calls.filter(x=>x.options.method==='POST').length,0);
  await api.start('mjobs','START MJobs','stable-123');
  assert.equal(calls.at(-1).url,'http://127.0.0.1:8787/api/startup');
  assert.deepEqual(JSON.parse(calls.at(-1).options.body),{confirm:'STARTUP',requestId:'stable-123',openUi:false,startWorkAfter:true});
  await api.start('babytracker','START BabyTracker');
  assert.equal(JSON.parse(calls.at(-1).options.body).action,'start');
});
test('progress summaries contain counts only and preserve unknown evidence',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-hub-test-'));
  try{
    fs.writeFileSync(path.join(dir,'artifact-review-state.json'),JSON.stringify({version:1,tasks:{a:{state:'review_ready',acceptance:'unassessed'},b:{state:'uncertain'}}}));
    fs.writeFileSync(path.join(dir,'productive-work-state.json'),JSON.stringify({version:1,tasks:{c:{state:'artifact_ready',acceptance:'unreviewed'}}}));
    assert.deepEqual(readMJobsProgress(dir),{available:true,reviews:{total:2,ready:1,inFlight:1,unassessed:1},drafts:{total:1,ready:1,inFlight:0,unreviewed:1}});
    assert.deepEqual(babyProgress({tasks:[{title:'private',status:'proposed',acceptance:'NOT_ASSESSED'}]}),{available:true,tasks:{total:1,proposed:1,inFlight:0,accepted:0,unassessed:1}});
    assert.deepEqual(mjobsLifecycle({workItems:[{issue:7,state:'approved'},{issue:9,state:'completed'}],artifactReviews:{ready:1}}),{available:true,approved:1,leased:0,completed:1,reviewReady:1});
    assert.deepEqual(readMJobsProgress(path.join(dir,'missing')),{available:false});
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
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
  }finally{await new Promise(resolve=>server.close(resolve));}
});
