'use strict';
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const edge='C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const exe=fs.existsSync(edge)?edge:'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe';
const proc=spawn(exe,['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-port=9242','--remote-allow-origins=*','--user-data-dir='+path.join(__dirname,'sustain-browser-profile'),'--window-size=1520,1100','http://127.0.0.1:8787'],{windowsHide:true,stdio:'ignore'});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function test(){
 let page;
 for(let i=0;i<35;i++){
  try{const tabs=await(await fetch('http://127.0.0.1:9242/json/list')).json();page=tabs.find(x=>x.url.includes('127.0.0.1:8787'));if(page)break}catch{}
  await sleep(260);
 }
 if(!page)throw Error('Browser not ready');
 const ws=new WebSocket(page.webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});
 let id=0;const queries=new Map();
 ws.onmessage=e=>{const msg=JSON.parse(e.data);const pending=queries.get(msg.id);if(!pending)return;queries.delete(msg.id);msg.error?pending.reject(Error(msg.error.message)):pending.resolve(msg.result)};
 const call=(method,params={})=>new Promise((resolve,reject)=>{const num=++id;queries.set(num,{resolve,reject});ws.send(JSON.stringify({id:num,method,params}))});
 const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error('Browser exception: '+JSON.stringify(r.exceptionDetails));return r.result?.value};
 await call('Runtime.enable');await call('Page.enable');await sleep(1700);
 let ui;
 for(let i=0;i<30;i++){
  ui=await evaluate('({active:!!window.FleetSustainUI?.isEnabled(),badge:document.getElementById("sustainBadge").textContent,control:document.getElementById("sustainToggle").textContent,rows:document.querySelectorAll("#tableRows tr").length,budget:document.getElementById("turboHour").textContent,allHandsPresent:!!document.getElementById("turboAllHands")})');
  if(ui.active&&ui.rows>=27)break;
  await sleep(300);
 }
 if(!ui.active||ui.rows<27||!ui.control.includes('Pause sustained'))throw Error('Sustained UI not live: '+JSON.stringify(ui));
 if(ui.budget.includes('/ 18'))throw Error('Old hourly limit still shown during sustained mode');
 await evaluate('document.getElementById("sustainPanel").scrollIntoView({block:"start"})');
 await sleep(150);
 const shot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
 fs.writeFileSync(path.join(__dirname,'sustain-dashboard-preview.png'),Buffer.from(shot.data,'base64'));
 console.log(JSON.stringify({...ui,screenshot:'sustain-dashboard-preview.png'},null,2));
 ws.close();
}
test().catch(e=>{console.error(e.stack);process.exitCode=1}).finally(()=>{try{proc.kill()}catch{}setTimeout(()=>process.exit(process.exitCode||0),200)});
