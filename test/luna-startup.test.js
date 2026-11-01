'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {createLunaStartup,CONFIRM}=require('../src/luna-startup');
const {makeServer}=require('../src/server');
const binding={projectId:'babytracker-master',repository:'https://github.com/MulattoTech/BabyTracker-Master.git',
  repoPath:'C:\\Tools\\Dev\\BabyTracker-Master',automationId:'automation-54ab57d9-7573-492a-a0ee-f562b11d34d5',
  quotaFile:'C:\\Tools\\AO-Fleet-Control\\quota-guard-status.json'};
const clock=Date.parse('2026-11-01T19:40:00Z');
function fake({quota,repo=binding.repository,model='gpt-6-luna',active=false}={}){
  const calls=[];
  let enabled=false;
  const run=async args=>{
    calls.push(args);
    if(args[0]==='project')return {project:{id:binding.projectId,repo,path:binding.repoPath,
      config:{worker:{agent:'codex',agentConfig:{model}},orchestrator:{agent:'codex',agentConfig:{model}}}}};
    if(args[0]==='automation'&&args[1]==='update'){enabled=true;return {automation:{enabled:true}};}
    if(args[0]==='automation')return {automation:{id:binding.automationId,projectId:binding.projectId,
      kind:'orchestrator',harness:'codex',prompt:'HARD LIMIT: gpt-6-luna workers',enabled}};
    if(args[0]==='session')return {data:active?[{activity:'working',isTerminated:false}]:[]};
    if(args[0]==='agent')return {supported:[{id:'codex',authStatus:'authorized'}]};
    throw Error('Unrecognized fake AO command');
  };
  const healthy={lastSuccessfulPoll:new Date(clock).toISOString(),status:'ready',
    config:{minimumRemainingPercent:7},windows:[{remainingPercent:75}],ordinaryUsageAllowed:true};
  return {luna:createLunaStartup({config:()=>binding,run,readQuota:()=>quota||healthy,now:()=>clock}),calls};
}
test('verified Luna preview and exact confirmation enable only the fixed automation',async()=>{
  const {luna,calls}=fake();
  const preview=await luna.preview();
  assert.equal(preview.blocked,false);
  assert.equal(preview.workerLimit,4);
  await assert.rejects(luna.start('START anything'),/confirmation/);
  const result=await luna.start(CONFIRM);
  assert.equal(result.ok,true);
  assert.equal(calls.filter(x=>x[0]==='automation'&&x[1]==='update').length,1);
  assert.deepEqual(calls.find(x=>x[0]==='automation'&&x[1]==='update'),
    ['automation','update',binding.automationId,'--enabled=true','--json']);
  assert.equal((await luna.preview()).blocked,true);
});
test('quota emergency lock, floor, active sessions and repo mismatch refuse launches',async()=>{
  const cases=[
    {quota:{lastSuccessfulPoll:new Date(clock).toISOString(),status:'emergency_locked',config:{minimumRemainingPercent:7},windows:[{remainingPercent:75}]}},
    {quota:{lastSuccessfulPoll:new Date(clock).toISOString(),status:'ready',config:{minimumRemainingPercent:7},windows:[{remainingPercent:7}]}},
    {active:true},
    {repo:'https://github.com/Other/Repo.git'},
    {model:'claude-sonnet-4-6'}
  ];
  for(const c of cases){
    const {luna,calls}=fake(c);
    assert.equal((await luna.preview()).blocked,true);
    await assert.rejects(luna.start(CONFIRM),/blocked/);
    assert.equal(calls.some(x=>x[0]==='automation'&&x[1]==='update'),false);
  }
});
test('HTTP Luna start requires host, origin, action token and exact confirmation',async()=>{
  const requests=[];
  const luna={preview:async()=>({blocked:false,confirmation:CONFIRM}),start:async value=>{requests.push(value);return {ok:true,note:'enabled'};}};
  const server=makeServer({port:46881,remote:null,luna,
    adapters:{},services:{}});
  await new Promise(resolve=>server.listen(46881,'127.0.0.1',resolve));
  const send=(method,route,headers={},body)=>new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port:46881,path:route,method,headers},res=>{
      let data='';res.on('data',part=>data+=part);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(data)}));});
    req.on('error',reject);req.end(body);
  });
  try{
    const session=await send('GET','/api/session');
    const token=session.body.token;
    assert.equal((await send('GET','/api/luna/preview')).status,200);
    const body=JSON.stringify({confirmation:CONFIRM});
    assert.equal((await send('POST','/api/luna/start',{'content-type':'application/json'},body)).status,403);
    const headers={origin:'http://127.0.0.1:46881','content-type':'application/json','x-fleet-hub':token};
    assert.equal((await send('POST','/api/luna/start',{...headers,origin:'https://evil.example'},body)).status,403);
    assert.equal((await send('POST','/api/luna/start',headers,JSON.stringify({confirmation:CONFIRM,command:'whoami'}))).status,400);
    assert.equal((await send('POST','/api/luna/start',headers,body)).status,202);
    assert.deepEqual(requests,[CONFIRM]);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
