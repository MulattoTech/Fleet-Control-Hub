'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {EventEmitter}=require('node:events');
const {makeServer}=require('../src/server');
const {createServiceLaunchpad}=require('../src/service-launchpad');

test('fixed Plex launch uses no request arguments and records audit without touching services',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-services-'));
  const exe=path.join(dir,'Plex Media Server.exe'),auditFile=path.join(dir,'audit.jsonl');fs.writeFileSync(exe,'fixture');
  const calls=[];
  const launch=(file,args,options)=>{calls.push({file,args,options});const child=new EventEmitter();child.unref=()=>{};queueMicrotask(()=>child.emit('spawn'));return child;};
  const processRun=async(file,args)=>{
    if(file==='tasklist.exe')return {stdout:'INFO: No tasks are running which match the specified criteria.'};
    if(file==='schtasks.exe')throw Error('not installed');
    if(file==='sc.exe')return {stdout:'STATE : 4 RUNNING'};
    throw Error('unexpected command');
  };
  try{
    const svc=createServiceLaunchpad({processRun,launch,auditFile,plexPath:exe});
    const state=await svc.status();
    assert.deepEqual(state.plex,{running:false,canStart:true});
    assert.deepEqual(state.rustdesk,{state:'running',canRestart:false});
    assert.deepEqual(state.tailscale,{state:'running',canRestart:false});
    await assert.rejects(svc.act('arbitrary-command'),/Unknown service action/);
    await assert.rejects(svc.act('rustdesk-restart'),/broker/);
    await svc.act('plex-start');
    assert.deepEqual(calls.map(c=>[c.file,c.args]),[[exe,[]]]);
    assert.deepEqual(fs.readFileSync(auditFile,'utf8').trim().split('\n').map(x=>JSON.parse(x).outcome),['requested','accepted']);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('Docker recovery invokes only fixed desktop CLI arguments and shares a cooldown',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-docker-'));
  const docker=path.join(dir,'docker.exe'),auditFile=path.join(dir,'audit.jsonl');fs.writeFileSync(docker,'fixture');
  const calls=[];let healthy=false;
  const processRun=async(file,args)=>{calls.push([file,args]);if(args[0]==='info')return healthy?{stdout:'29.9.2'}:Promise.reject(Error('unhealthy'));if(args[0]==='desktop'&&args[1]==='start'){healthy=true;return {stdout:''};}return {stdout:''};};
  try{
    const svc=createServiceLaunchpad({processRun,dockerPath:docker,auditFile});
    await svc.act('docker-start');
    assert.ok(calls.some(([file,args])=>file===docker&&args.join(' ')==='desktop start --detach'));
    await assert.rejects(svc.act('docker-restart'),/cooldown/);
    assert.equal(calls.some(([,args])=>args[1]==='stop'),false);
    const fresh=createServiceLaunchpad({processRun,dockerPath:docker,auditFile});
    await fresh.act('docker-restart');
    assert.ok(calls.some(([file,args])=>file===docker&&args.join(' ')==='desktop stop --timeout 60'));
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('service actions reject unauthenticated, cross-origin, unknown and replayed requests',async()=>{
  const calls=[];
  const services={status:async()=>({plex:{running:false,canStart:true},rustdesk:{state:'running',canRestart:false}}),act:async action=>{calls.push(action);return {ok:true,note:'mocked'};}};
  const remote={hostname:'fleet.m-techlabs.com',issuer:'https://example.cloudflareaccess.com',audience:'a'.repeat(64),ownerEmail:'owner@example.test'};
  const server=makeServer({port:4336,remote,verifyRemote:async token=>{if(token!=='verified')throw Error('denied');},services});
  await new Promise(resolve=>server.listen(4336,'127.0.0.1',resolve));
  const send=(path,method,headers={},body)=>new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:4336,path,method,headers:{host:'fleet.m-techlabs.com',...headers}},res=>{let data='';res.on('data',chunk=>data+=chunk);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(data)}));});req.on('error',reject);req.end(body);});
  try{
    assert.equal((await send('/api/services/nonce','GET')).status,403);
    const auth={'cf-access-jwt-assertion':'verified'};
    const session=await send('/api/session','GET',auth),token=session.data.token;
    const nonce=(await send('/api/services/nonce','GET',auth)).data.nonce;
    const body=JSON.stringify({action:'plex-start',confirmation:'RUN plex-start',nonce});
    const good={...auth,origin:'https://fleet.m-techlabs.com','x-fleet-hub':token,'content-type':'application/json'};
    assert.equal((await send('/api/services/action','POST',{...good,'cf-access-jwt-assertion':'wrong'},body)).status,403);
    assert.equal((await send('/api/services/action','POST',{...good,origin:'https://evil.example'},body)).status,403);
    assert.equal((await send('/api/services/action','POST',{...good,'x-fleet-hub':'wrong'},body)).status,403);
    assert.equal((await send('/api/services/action','POST',good,JSON.stringify({action:'arbitrary-command',confirmation:'RUN arbitrary-command',nonce}))).status,400);
    assert.equal((await send('/api/services/action','POST',good,body)).status,202);
    assert.equal((await send('/api/services/action','POST',good,body)).status,409);
    assert.deepEqual(calls,['plex-start']);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
test('Monai recovery invokes only the fixed launcher and refuses duplicate gateway start',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-monai-'));
  const launcher=path.join(dir,'start_service.vbs'),auditFile=path.join(dir,'audit.jsonl');fs.writeFileSync(launcher,'fixture');
  const calls=[];let running=false;
  const processRun=async(file,args)=>{
    calls.push([file,args]);
    if(file==='tasklist.exe')return {stdout:running?'"mediamtx.exe","123","Console","1","1 K"':'INFO: No tasks are running'};
    if(file==='wscript.exe'){running=true;return {stdout:''};}
    throw Error('unexpected command');
  };
  try{
    const svc=createServiceLaunchpad({processRun,monaiPath:launcher,auditFile});
    await svc.act('monai-start');
    assert.deepEqual(calls.filter(([file])=>file==='wscript.exe'),[['wscript.exe',['//B','//Nologo',launcher]]]);
    await svc.act('monai-start');
    assert.equal(calls.filter(([file])=>file==='wscript.exe').length,1);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
