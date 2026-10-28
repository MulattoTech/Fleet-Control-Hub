'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const edge='C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const exe=fs.existsSync(edge)?edge:'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe';
const child=spawn(exe,['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-port=9258','--remote-allow-origins=*','--user-data-dir='+path.join(__dirname,'find-work-browser-profile'),'--window-size=1560,1090','http://127.0.0.1:8787'],{windowsHide:true,stdio:'ignore'});
const delay=t=>new Promise(r=>setTimeout(r,t));
async function main(){
 let tab;
 for(let i=0;i<40;i++){
  try{const tabs=await(await fetch('http://127.0.0.1:9258/json/list')).json();tab=tabs.find(x=>x.url.includes('127.0.0.1:8787'));if(tab)break}catch{}
  await delay(250);
 }
 if(!tab)throw Error('Edge test browser unavailable');
 const ws=new WebSocket(tab.webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});
 let n=0;const queue=new Map();
 ws.onmessage=e=>{const x=JSON.parse(e.data),v=queue.get(x.id);if(!v)return;queue.delete(x.id);x.error?v.reject(Error(x.error.message)):v.resolve(x.result)};
 const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++n;queue.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))});
 const evaluate=async expression=>{
  const response=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
  if(response.exceptionDetails)throw Error('Browser JS exception: '+JSON.stringify(response.exceptionDetails).slice(0,500));
  return response.result?.value;
 };
 await call('Runtime.enable');await call('Page.enable');
 let state;
 for(let i=0;i<35;i++){
  state=await evaluate('({rows:document.querySelectorAll("#tableRows tr").length,buttons:document.querySelectorAll("[data-action=find-work]").length,enabled:document.querySelectorAll("[data-action=find-work]:not(:disabled)").length,global:!!document.querySelector("#findWorkAll"),label:document.querySelector("#findWorkAll")?.textContent,script:typeof FleetFindWorkUI!=="undefined"})');
  if(state.script&&state.rows>25&&state.buttons===state.rows)break;
  await delay(200);
 }
 if(!state.script||state.rows<25||state.buttons!==state.rows||!state.global)throw Error('Find Work UI did not load: '+JSON.stringify(state));
 await evaluate('document.querySelector(".roster-section").scrollIntoView({block:"start",behavior:"instant"})');
 await delay(100);
 const shot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
 fs.writeFileSync(path.join(__dirname,'find-work-dashboard-preview.png'),Buffer.from(shot.data,'base64'));
 await evaluate('document.querySelector("#findWorkAll").click()');
 let modal;
 for(let i=0;i<35;i++){
  modal=await evaluate('({open:!document.querySelector("#modalOverlay").hidden,confirm:!!document.querySelector("#confirmFindWorkAll"),content:document.querySelector("#modalBody").textContent.slice(0,350)})');
  if(modal.confirm)break;
  await delay(200);
 }
 if(!modal.confirm||!modal.open||!modal.content.includes('Existing unfinished PRs'))throw Error('Bulk confirmation invalid: '+JSON.stringify(modal));
 await evaluate('document.querySelector("[data-modal=cancel]").click()');
 const closed=await evaluate('document.querySelector("#modalOverlay").hidden');
 if(!closed)throw Error('Find Work cancel failed');
 const status=await(await fetch('http://127.0.0.1:8787/api/find-work/status')).json();
 if(status.lastBulk)throw Error('UI browser test unexpectedly submitted a fleet-wide Find Work command');
 console.log(JSON.stringify({roster:state,modal,closed,noDispatch:true,screenshot:'C:\\Tools\\AO-Fleet-Control\\find-work-dashboard-preview.png'},null,2));
 ws.close();
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{try{child.kill()}catch{}setTimeout(()=>process.exit(process.exitCode||0),180)});
