'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');

function uiFixture(){
  const calls=[],timers=[],storage=new Map(),observed=[];
  const nodes=new Map();
  function node(){return {disabled:false,append(){},replaceChildren(){},setAttribute(){},addEventListener(){}};}
  const get=id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);};
  let mode='paused',postOutcome='ok',release=null;
  const context=vm.createContext({document:{getElementById:get,createElement:node,createTextNode:x=>x,querySelectorAll:()=>[]},location:{hostname:'localhost'},crypto:{randomUUID:()=> 'stable-ui-request'},sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
    confirm(){throw Error('Normal Start must not ask for confirmation');},setInterval:(callback,ms)=>timers.push({callback,ms}),observed,
    fetch:async(url,options={})=>{calls.push({url,options});
      if(url==='/api/session')return {ok:true,json:async()=>({token:'local-token'})};
      if(url.startsWith('/api/start-preview'))return {ok:true,json:async()=>({blocked:false,quotaFresh:true,confirmation:'START MJobs'})};
      if(url==='/api/start'){
        if(postOutcome==='pending')await new Promise(resolve=>{release=resolve;});
        if(postOutcome==='transport')throw Error('response lost');
        if(postOutcome==='refused')return {ok:false,status:502,json:async()=>({error:'quota hold',definitive:true})};
        if(postOutcome==='upstreamTransport')return {ok:false,status:502,json:async()=>({error:'native response lost',definitive:false})};
        mode='running';return {ok:true,json:async()=>({note:'Start acknowledged'})};
      }
      if(url==='/api/status')return {ok:true,json:async()=>({fleets:[{id:'mjobs',mode}],observedAt:new Date().toISOString()})};
      return {ok:false,json:async()=>({error:'fixture service unavailable'})};
    }});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8'),context);
  vm.runInContext('render=fleets=>observed.push(fleets[0].mode);confirmAction=()=>{throw Error("Normal Start opened a dialog");};',context);
  return {context,calls,timers,storage,observed,setOutcome:v=>postOutcome=v,release:()=>release(),setMode:v=>mode=v,start:()=>vm.runInContext('startFleet("mjobs","MJobs",{disabled:false})',context)};
}

test('Hub Start submits once on double click without confirmation and polls real controller status',async()=>{
  const f=uiFixture();await new Promise(resolve=>setImmediate(resolve));f.setOutcome('pending');
  const first=f.start();await f.start();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.calls.filter(c=>c.url==='/api/start').length,1);
  assert.equal(JSON.parse(f.calls.find(c=>c.url==='/api/start').options.body).requestId,'stable-ui-request');
  f.release();await first;
  assert.equal(f.observed.at(-1),'running');assert.equal(f.storage.size,0);
  f.setMode('paused');await f.timers.find(t=>t.ms===3000).callback();assert.equal(f.observed.at(-1),'paused');
});
test('Hub Start retains the request after transport failure and clears it after definitive refusal',async()=>{
  const f=uiFixture();await new Promise(resolve=>setImmediate(resolve));f.setOutcome('transport');await f.start();
  assert.equal(f.storage.get('mjobsStartRequestId'),'stable-ui-request');
  f.setOutcome('upstreamTransport');await f.start();assert.equal(f.storage.get('mjobsStartRequestId'),'stable-ui-request');
  f.setOutcome('refused');await f.start();assert.equal(f.storage.size,0);
  const bodies=f.calls.filter(c=>c.url==='/api/start').map(c=>JSON.parse(c.options.body));
  assert.equal(bodies.length,3);assert.equal(bodies[0].requestId,bodies[1].requestId);assert.equal(bodies[1].requestId,bodies[2].requestId);
});
