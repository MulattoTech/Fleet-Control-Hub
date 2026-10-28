'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const assert=require('node:assert/strict');
const root=__dirname;
const candidates=['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe','C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'];
const edge=candidates.find(fs.existsSync);if(!edge)throw Error('Edge is missing');
const profile=path.join(root,'diagnostics','recovery-ui-'+Date.now());fs.mkdirSync(profile,{recursive:true});
const child=spawn(edge,['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+profile,'--window-size=1550,1150','http://127.0.0.1:8787'],{windowsHide:true,stdio:'ignore'});
const sleep=n=>new Promise(r=>setTimeout(r,n));
let ws;
(async()=>{
 let port;
 for(let i=0;i<50;i++){try{port=Number(fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]);if(port)break}catch{}await sleep(200)}
 assert.ok(port,'Test browser debugging endpoint unavailable');
 let page;
 for(let i=0;i<25;i++){const tabs=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();page=tabs.find(t=>t.type==='page'&&t.url.includes(':8787'));if(page)break;await sleep(200)}
 assert.ok(page,'Dashboard page unavailable');
 ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((ok,no)=>{ws.onopen=ok;ws.onerror=no});
 const pending=new Map(),exceptions=[];let n=0;
 ws.onmessage=e=>{const msg=JSON.parse(e.data);if(msg.method==='Runtime.exceptionThrown')exceptions.push(msg.params.exceptionDetails.text+': '+(msg.params.exceptionDetails.exception?.description||''));const p=pending.get(msg.id);if(!p)return;pending.delete(msg.id);clearTimeout(p.timer);msg.error?p.reject(Error(msg.error.message)):p.resolve(msg.result)};
 const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++n;const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method))},8000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}))});
 const evaluate=async exp=>{const v=await call('Runtime.evaluate',{expression:exp,returnByValue:true,awaitPromise:true});if(v.exceptionDetails)throw Error(JSON.stringify(v.exceptionDetails));return v.result?.value};
 await call('Runtime.enable');await call('Page.enable');
 let info;
 for(let i=0;i<45;i++){
  info=await evaluate('({rows:document.querySelectorAll("#tableRows tr").length,threshold:document.querySelector("#quotaThreshold")?.value,guard:document.querySelector("#quotaGuardStatus")?.textContent,sustain:document.querySelector("#sustainBadge")?.textContent,recovery:document.querySelector("#restorePhase")?.textContent,restored:document.querySelector("#restoreNumbers")?.textContent,findButtons:document.querySelectorAll("[data-action=find-work]").length,hasAllIdle:!!document.querySelector("#findWorkAll"),weekly:document.querySelector("#quotaWeeklyValue")?.textContent})');
  if(info.rows===29&&info.threshold==='7'&&info.guard?.includes('ARMED')&&info.sustain?.includes('RUNNING'))break;
  await sleep(250);
 }
 assert.equal(info.rows,29);assert.equal(info.threshold,'7');assert.match(info.guard,/ARMED.*7%/);assert.match(info.sustain,/RUNNING|THROTTLED/);assert.equal(info.findButtons,29);assert.ok(info.hasAllIdle);assert.match(info.restored,/29 \/ 29/);assert.equal(exceptions.length,0,exceptions.join('\n'));
 const image=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(root,'diagnostics','recovery-7pct-verified.png'),Buffer.from(image.data,'base64'));
 const q=await(await fetch('http://127.0.0.1:8787/api/quota')).json();const m=await(await fetch('http://127.0.0.1:8787/api/master')).json();
 assert.ok(q.config.autoKillArmed&&q.config.thresholdPercent===7);assert.ok(!m.emergency.latched&&!m.restore.active);
 console.log(JSON.stringify({PASS:true,ui:info,javascriptErrors:exceptions,safetyArmed:true,noControlsClicked:true},null,2));
 try{await call('Browser.close')}catch{}ws.close();
})().catch(e=>{console.error(e.stack);process.exitCode=1}).finally(()=>{try{ws?.close()}catch{}try{child.kill()}catch{}setTimeout(()=>process.exit(process.exitCode||0),200)});
