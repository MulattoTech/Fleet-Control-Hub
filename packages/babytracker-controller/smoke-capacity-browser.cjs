'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const {FleetController}=require('./controller'),{createServer}=require('./server'),{PROJECT,SOURCE_REPO,ISSUE_REPO}=require('./config');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'baby-capacity-browser-'));let chrome,ws,server;
 try{
  const config={projectId:PROJECT,sourceRepository:SOURCE_REPO,issueRepository:ISSUE_REPO,stateDir:path.join(root,'state'),runtimeVerified:true};
  const mk=(id,harness,state,kind='worker')=>({id,projectId:PROJECT,harness,kind,displayName:id,activity:{state},mode:harness==='agy'?'tui':'chat',isTerminated:false});
  const sessions=[mk('baby-orchestrator','codex','active','orchestrator'),mk('baby-worker','codex','active'),mk('baby-idle','codex','idle'),mk('baby-gemini','agy','idle')],calls=[];
  const c=new FleetController(config,{adapter:{sessions:async()=>structuredClone(sessions),command:async(...args)=>{calls.push(args);throw Error('Browser smoke must not dispatch an agent');}},quota:()=>({fresh:true,remainingPercent:13,sharedEmergencyGuard:{thresholdPercent:7,armed:true}}),resources:()=>({freeMemoryGiB:18,totalMemoryGiB:64,cpuPercent:null,diskIO:null})});
  c.limits({minimumRemainingPercent:7});await c.start();c.state.run.dispatches=3;c.state.plans['baby-orchestrator']={status:'staged',harness:'agy',model:'gemini-3.8-flash-high'};const runBefore=structuredClone(c.state.run);
  server=createServer({config,controller:c});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
  const profile=path.join(root,'chrome');fs.mkdirSync(profile);
  chrome=spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--disable-gpu','--disable-extensions','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
  let port;
  for(let i=0;i<60;i++){try{port=Number(fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]);if(port)break;}catch{}await sleep(100);}
  assert.ok(port,'Dedicated synthetic browser started');
  const tabs=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();ws=new WebSocket(tabs.find(x=>x.type==='page').webSocketDebuggerUrl);
  await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true})});
  const pending=new Map();let n=0;const errors=[];
  ws.addEventListener('message',ev=>{const x=JSON.parse(String(ev.data));if(x.id&&pending.has(x.id)){const p=pending.get(x.id);clearTimeout(p.timer);pending.delete(x.id);x.error?p.reject(Error(x.error.message)):p.resolve(x.result);}else if(x.method==='Runtime.exceptionThrown')errors.push(x.params.exceptionDetails.text);});
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++n,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method));},6000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>(await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})).result?.value;
  const until=async predicate=>{for(let i=0;i<40;i++){if(await evaluate(predicate))return;await sleep(150);}throw Error('Browser condition failed: '+predicate);};
  await send('Runtime.enable');await send('Page.enable');await send('Page.navigate',{url:origin});
  await until("document.querySelector('#capacityState')?.textContent.includes('2 / 2') && document.querySelector('#rows')?.textContent.includes('baby-idle')");
  assert.equal(await evaluate("document.querySelector('[data-session=\"baby-idle\"][data-op=\"find-work\"]').disabled"),true);
  assert.equal(await evaluate("document.querySelector('[data-action=\"all-hands\"]').disabled"),true);
  assert.equal(await evaluate("document.querySelector('#capacityOwners').textContent.includes('baby-orchestrator / codex')"),true);
  assert.equal(await evaluate("document.querySelector('#rows').textContent.includes('UNAPPLIED preference only')"),true);
  await evaluate("window.confirm=()=>true; document.querySelector('#concurrencyLimit').value='4';document.querySelector('#concurrencyLimit').dispatchEvent(new Event('input'));document.querySelector('#concurrencySave').click(); true");
  await until("document.querySelector('#capacityState').textContent.includes('2 / 4') && !document.querySelector('[data-session=\"baby-idle\"][data-op=\"find-work\"]').disabled");
  assert.equal(c.state.limits.concurrency,4);assert.deepEqual(c.state.run,runBefore);assert.equal(c.state.limits.minimumRemainingPercent,7);
  await until("!document.querySelector('#concurrencySave').disabled");
  await evaluate("document.querySelector('#concurrencyLimit').value='1';document.querySelector('#concurrencyLimit').dispatchEvent(new Event('input'));document.querySelector('#concurrencySave').click();true");
  await until("document.querySelector('#capacityState').textContent.includes('2 / 1') && document.querySelector('[data-session=\"baby-idle\"][data-op=\"find-work\"]').disabled");
  assert.equal(c.state.mode,'running');assert.equal(calls.length,0);assert.equal(errors.length,0);assert.deepEqual(c.state.run,runBefore);
  console.log('BROWSER_SMOKE=PASS: real Save button 2 -> 4 -> 1; active workers untouched; disabled buttons track capacity; quota and run budget preserved; zero native agent calls; no browser JS errors');
  try{await send('Browser.close');}catch{}await sleep(400);
 }finally{
  ws?.close();if(chrome&&chrome.exitCode===null)chrome.kill();
  if(server)await new Promise(r=>{server.close(r);server.closeAllConnections();});
  await sleep(400);try{fs.rmSync(root,{recursive:true,force:true,maxRetries:6,retryDelay:200});console.log('SYNTHETIC_RESOURCES=REMOVED');}catch{console.log('SYNTHETIC_RESOURCES='+root);}
 }
})().catch(e=>{console.error(e.stack);process.exitCode=1});
