'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {makeServer}=require('../src/server');
const {createBabyTrackerBridge,ORIGIN,ASSETS,READS,WRITES}=require('../src/babytracker-bridge');

function request(port,path,{method='GET',host,origin,access,headers={},body}={}){
  return new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port,path,method,headers:{...(host?{host}:{}),
      ...(origin?{origin}:{}),...(access?{'cf-access-jwt-assertion':access}:{}),...headers}},res=>{
      const chunks=[];res.on('data',d=>chunks.push(d));res.on('end',()=>resolve({code:res.statusCode,body:Buffer.concat(chunks),headers:res.headers}));
    });req.on('error',reject);req.end(body);
  });
}
async function withHub(port,options,run){
  const server=makeServer({port,...options});await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  try{await run();}finally{await new Promise(resolve=>server.close(resolve));}
}
function fixture(){
  const calls=[];
  const fetcher=async(url,options)=>{
    calls.push({url,options});const route=new URL(url).pathname;
    if(route==='/')return new Response('<link rel="stylesheet" href="babytracker.css">',
      {headers:{'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'none'; script-src 'self'"}});
    if(route==='/app.js')return new Response('window.BabyTracker=true;',
      {headers:{'content-type':'text/javascript; charset=utf-8'}});
    if(route==='/api/state')return Response.json({project:'babytracker',mode:'paused'});
    if(route==='/api/action')return Response.json({ok:true});
    throw Error('unexpected native path');
  };
  return {calls,fetcher};
}

test('local Hub relays native BabyTracker views and read-only state under stable prefix',async()=>{
  const f=fixture(),port=4380;
  await withHub(port,{babyTrackerBridge:createBabyTrackerBridge({fetcher:f.fetcher})},async()=>{
    const redirect=await request(port,'/babytracker');assert.equal(redirect.code,307);
    assert.equal(redirect.headers.location,'/babytracker/');
    const page=await request(port,'/babytracker/');assert.equal(page.code,200);
    assert.match(page.body.toString(),/babytracker.css/);
    assert.match(page.headers['content-security-policy'],/script-src 'self'/);
    assert.equal((await request(port,'/babytracker/app.js')).code,200);
    const state=await request(port,'/babytracker/api/state');assert.equal(JSON.parse(state.body).project,'babytracker');
    assert.deepEqual(f.calls.map(x=>x.url),[ORIGIN+'/',ORIGIN+'/app.js',ORIGIN+'/api/state']);
    assert.ok(f.calls.every(x=>x.options.headers.Host==='127.0.0.1:4319'&&!x.options.headers.Cookie));
    assert.ok(ASSETS.has('projects.js')&&READS.has('api/session')&&WRITES.has('api/action'));
  });
});

test('BabyTracker proxy rejects unknown paths and cross-origin/non-token writes without forwarding',async()=>{
  const f=fixture(),port=4381,token='a'.repeat(64),base='http://127.0.0.1:'+port;
  await withHub(port,{babyTrackerBridge:createBabyTrackerBridge({fetcher:f.fetcher})},async()=>{
    for(const path of ['/babytracker/api/private','/babytracker/app.js?x=1','/babytracker/%2e%2e/api/state','/babytracker/api/action'])
      assert.equal((await request(port,path)).code,404,path);
    const post=(origin,headers={},body='{}')=>request(port,'/babytracker/api/action',{method:'POST',origin,headers:{'content-type':'application/json','x-babytracker-fleet':token,...headers},body});
    assert.equal((await post('https://evil.example')).code,403);
    assert.equal((await post(base,{'x-babytracker-fleet':'bad'})).code,403);
    assert.equal((await post(base,{'content-type':'text/plain'})).code,415);
    assert.equal(f.calls.length,0);
    assert.equal((await post(base)).code,200);
    assert.equal(f.calls.length,1);
    assert.equal(f.calls[0].options.headers.Origin,ORIGIN);
    assert.equal(f.calls[0].options.headers['X-BabyTracker-Fleet'],token);
  });
});

test('Cloudflare owner verification protects native BabyTracker UI and actions',async()=>{
  const f=fixture(),port=4382,token='b'.repeat(64),remote={hostname:'fleet.m-techlabs.com'};
  await withHub(port,{remote,verifyRemote:async value=>{if(value!=='verified')throw Error('not owner');},babyTrackerBridge:createBabyTrackerBridge({fetcher:f.fetcher})},async()=>{
    const req=(path,options={})=>request(port,path,{host:remote.hostname,...options});
    assert.equal((await req('/babytracker/')).code,403);
    assert.equal((await req('/babytracker/',{access:'verified'})).code,200);
    assert.equal((await req('/babytracker/api/action',{method:'POST',access:'verified',origin:'http://127.0.0.1:4382',headers:{'content-type':'application/json','x-babytracker-fleet':token},body:'{}'})).code,403);
    assert.equal((await req('/babytracker/api/action',{method:'POST',access:'verified',origin:'https://fleet.m-techlabs.com',headers:{'content-type':'application/json','x-babytracker-fleet':token},body:'{}'})).code,200);
    assert.equal(f.calls.length,2);
  });
});
