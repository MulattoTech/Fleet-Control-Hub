'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {createNativeFleetBridge,ASSETS,READS,WRITES,NATIVE_ORIGIN}=require('../src/native-fleet-bridge');
const {makeServer}=require('../src/server');

async function withHub(port,options,run){
  const server=makeServer({port,...options});
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  try{await run('http://127.0.0.1:'+port);}
  finally{await new Promise(resolve=>server.close(resolve));}
}
function fixture(){
  const calls=[];
  const html=Buffer.from('<!doctype html><title>Native MJobs Fleet</title><script defer src="/app.js"></script><a href="/">Home</a><a href="/unlisted">Other</a>');
  const js=Buffer.from('window.nativeFleetMarker="native";');
  const fetcher=async (url,options)=>{
    calls.push({url,options});
    const path=new URL(url).pathname;
    if(path==='/')return new Response(html,{status:200,headers:{'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'self'; script-src 'self'; connect-src 'self'"}});
    if(path==='/app.js')return new Response(js,{status:200,headers:{'content-type':'application/javascript; charset=utf-8'}});
    if(path==='/api/state')return Response.json({projectId:'mjobs-luna',sessions:[]});
    if(path==='/api/master/pause')return Response.json({ok:true});
    throw Error('Unexpected upstream route');
  };
  return {calls,fetcher,html,js};
}
function rawRequest(port,path,{method='GET',host,origin,access,headers={},body}={}){
  return new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port,path,method,headers:{...(host?{host}:{}),...(origin?{origin}:{}),...(access?{'cf-access-jwt-assertion':access}:{}),...headers}},res=>{
      const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks),headers:res.headers}));
    });
    req.on('error',reject);req.end(body);
  });
}

test('full native route comes directly from the controller with safe asset rebasing',async()=>{
  const f=fixture();
  await withHub(4342,{nativeFleetBridge:createNativeFleetBridge({fetcher:f.fetcher})},async base=>{
    const redirect=await fetch(base+'/fleet',{redirect:'manual'});
    assert.equal(redirect.status,307);assert.equal(redirect.headers.get('location'),'/fleet/');
    const page=await fetch(base+'/fleet/');assert.equal(page.status,200);
    const rendered=Buffer.from(await page.arrayBuffer()).toString();
    assert.match(rendered,/src="\/fleet\/app\.js"/);
    assert.match(rendered,/href="\/fleet\/"/);
    assert.match(rendered,/href="\/unlisted"/);
    assert.match(page.headers.get('content-security-policy'),/script-src 'self'/);
    const script=await fetch(base+'/fleet/app.js');
    assert.deepEqual(Buffer.from(await script.arrayBuffer()),f.js);
    const state=await (await fetch(base+'/fleet/api/state')).json();
    assert.equal(state.projectId,'mjobs-luna');
    assert.deepEqual(f.calls.map(c=>c.url),[NATIVE_ORIGIN+'/',NATIVE_ORIGIN+'/app.js',NATIVE_ORIGIN+'/api/state']);
    assert.ok(f.calls.every(c=>c.options.headers.Host==='127.0.0.1:8787'&&!('Cookie' in c.options.headers)));
  });
});

test('native route is exact, allowlisted, has no arbitrary URL, query, or write via GET',async()=>{
  const f=fixture();
  await withHub(4343,{nativeFleetBridge:createNativeFleetBridge({fetcher:f.fetcher})},async base=>{
    for(const path of ['/fleet/api/unknown','/fleet/api/nudge','/fleet/app.js?x=1','/fleet/%2fapi%2fstate','/fleet/not-a-file','/fleet/../api/state'])
      assert.equal((await fetch(base+path)).status,404,path);
    assert.equal(f.calls.length,0);
    assert.ok(ASSETS.has('run-ui.js')&&READS.has('api/run')&&WRITES.has('api/run/start'));
    assert.equal(WRITES.has('api/private-exec'),false);
  });
});

test('native writes demand owner-origin, JSON, and native header; relay once without automatic retry',async()=>{
  const f=fixture();
  await withHub(4344,{nativeFleetBridge:createNativeFleetBridge({fetcher:f.fetcher})},async base=>{
    const url='/fleet/api/master/pause',body='{}',port=4344;
    const request=extra=>rawRequest(port,url,{method:'POST',origin:base,headers:{'content-type':'application/json','x-ao-fleet':'1'},body,...extra});
    assert.equal((await request({origin:'https://evil.example'})).status,403);
    assert.equal((await request({headers:{'content-type':'application/json'}})).status,403);
    assert.equal((await request({headers:{'content-type':'text/plain','x-ao-fleet':'1'}})).status,415);
    assert.equal((await rawRequest(port,'/fleet/api/private-exec',{method:'POST',origin:base,headers:{'content-type':'application/json','x-ao-fleet':'1'},body})).status,404);
    assert.equal((await request({body:'x'.repeat(65537)})).status,413);
    assert.equal(f.calls.length,0);
    const ok=await request({});
    assert.equal(ok.status,200);assert.equal(JSON.parse(ok.body.toString()).ok,true);
    assert.equal(f.calls.length,1);assert.equal(f.calls[0].options.method,'POST');
    assert.equal(f.calls[0].options.headers.Origin,NATIVE_ORIGIN);
    assert.equal(f.calls[0].options.headers['X-AO-Fleet'],'1');
    assert.equal(f.calls[0].options.body.toString(),body);
  });
});

test('Cloudflare-protected remote path refuses missing owner assertion before native access',async()=>{
  const f=fixture(),remote={hostname:'fleet.m-techlabs.com',issuer:'https://example.cloudflareaccess.com',audience:'a'.repeat(64),ownerEmail:'owner@example.com'};
  await withHub(4345,{nativeFleetBridge:createNativeFleetBridge({fetcher:f.fetcher}),remote,verifyRemote:async token=>{if(token!=='verified')throw Error('Denied');}},async()=>{
    const port=4345,host=remote.hostname;
    assert.equal((await rawRequest(port,'/fleet/',{host})).status,403);
    assert.equal(f.calls.length,0);
    assert.equal((await rawRequest(port,'/fleet/',{host,access:'verified'})).status,200);
    const bad=await rawRequest(port,'/fleet/api/master/pause',{method:'POST',host,access:'verified',origin:'http://127.0.0.1:4345',headers:{'content-type':'application/json','x-ao-fleet':'1'},body:'{}'});
    assert.equal(bad.status,403);
    const good=await rawRequest(port,'/fleet/api/master/pause',{method:'POST',host,access:'verified',origin:'https://fleet.m-techlabs.com',headers:{'content-type':'application/json','x-ao-fleet':'1'},body:'{}'});
    assert.equal(good.status,200);
    assert.equal(f.calls.length,2);
  });
});
