'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createAdapters,loopbackEndpoint}=require('../src/adapters');
const {makeServer}=require('../src/server');

function fixture(){const calls=[];const fetcher=async(url,options={})=>{calls.push({url,options});
  if(url.endsWith('/api/state')&&url.includes(':8787'))return {ok:true,json:async()=>({projectId:'mjobs-luna',sessions:[{id:'a'}],summary:{total:1,working:0,idle:1,idlePending:0,ciAttention:0}})};
  if(url.endsWith('/api/master'))return {ok:true,json:async()=>({dispatch:{sustainedEnabled:false,turboEnabled:false}})};
  if(url.endsWith('/api/state')&&url.includes(':4319'))return {ok:true,json:async()=>({projectId:'babytracker',sessions:[{id:'b'}],runtime:{online:true},mode:'paused',tasks:[],summary:{total:1,working:0,available:1,blocked:0},acceptance:{status:'NOT_ASSESSED'}})};
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
  }finally{await new Promise(resolve=>server.close(resolve));}
});
