'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const edge='C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const browser=fs.existsSync(edge)?edge:'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe';
const child=spawn(browser,['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-port=9246','--remote-allow-origins=*','--user-data-dir='+path.join(__dirname,'master-control-browser-profile'),'--window-size=1550,1120','http://127.0.0.1:8787'],{windowsHide:true,stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
 let page;
 for(let i=0;i<40;i++){
  try{const pages=await(await fetch('http://127.0.0.1:9246/json/list')).json();page=pages.find(p=>p.url.includes('127.0.0.1:8787'));if(page)break}catch{}
  await sleep(250);
 }
 if(!page)throw Error('Headless browser unavailable');
 const ws=new WebSocket(page.webSocketDebuggerUrl);
 await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej});
 let counter=0;const calls=new Map();
 ws.onmessage=e=>{const r=JSON.parse(e.data),item=calls.get(r.id);if(!item)return;calls.delete(r.id);r.error?item.reject(Error(r.error.message)):item.resolve(r.result)};
 const call=(method,params={})=>new Promise((res,rej)=>{const id=++counter;calls.set(id,{resolve:res,reject:rej});ws.send(JSON.stringify({id,method,params}))});
 const evaluate=async expression=>{
  const v=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
  if(v.exceptionDetails)throw Error('JS exception: '+JSON.stringify(v.exceptionDetails).slice(0,500));
  return v.result?.value;
 };
 await call('Page.enable');await call('Runtime.enable');await sleep(1400);
 let initial;
 for(let i=0;i<30;i++){
  initial=await evaluate('({pause:!!document.querySelector("#masterPause"),drain:!!document.querySelector("#masterDrain"),kill:!!document.querySelector("#masterKill"),header:!!document.querySelector("#topbarKill"),status:document.querySelector("#masterState")?.textContent,rows:document.querySelectorAll("#tableRows tr").length})');
  if(initial.pause&&initial.rows>20&&initial.status!=='MONITORING')break;
  await sleep(280);
 }
 if(!initial.pause||!initial.drain||!initial.kill||!initial.header)throw Error('Master buttons are missing');
 const actual=await(await fetch('http://127.0.0.1:8787/api/master')).json();
 if(actual.emergency.latched)throw Error('Browser test refuses to operate while emergency latch is set');
 await evaluate('document.querySelector("#masterSection").scrollIntoView({block:"start",behavior:"instant"})');
 await sleep(110);
 const shot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
 fs.writeFileSync(path.join(__dirname,'master-controls-preview.png'),Buffer.from(shot.data,'base64'));
 await evaluate('document.querySelector("#masterKill").click()');
 let modal=await evaluate('({open:!document.querySelector("#modalOverlay").hidden,confirmDisabled:document.querySelector("#confirmEmergency").disabled,containsWarning:document.querySelector("#modalBody").textContent.includes("non-graceful shutdown")})');
 if(!modal.open||!modal.confirmDisabled||!modal.containsWarning)throw Error('Emergency confirmation is invalid: '+JSON.stringify(modal));
 await evaluate('(()=>{const f=document.querySelector("#emergencyPhrase");f.value="KILL ALL CODEX";f.dispatchEvent(new Event("input",{bubbles:true}));return document.querySelector("#confirmEmergency").disabled})()');
 const enabled=await evaluate('!document.querySelector("#confirmEmergency").disabled');
 if(!enabled)throw Error('Typed confirmation did not enable button');
 await evaluate('document.querySelector("[data-modal=cancel]").click()');
 const closed=await evaluate('document.querySelector("#modalOverlay").hidden');
 if(!closed)throw Error('Emergency cancel failed');
 await evaluate('document.querySelector("#masterDrain").click()');
 const drainConfirm=await evaluate('!document.querySelector("#modalOverlay").hidden && !!document.querySelector("#confirmGraceful")');
 if(!drainConfirm)throw Error('Graceful stop modal did not appear');
 await evaluate('document.querySelector("[data-modal=cancel]").click()');
 const final=await(await fetch('http://127.0.0.1:8787/api/master')).json();
 if(final.emergency.latched||final.drain.enabled)throw Error('Browser test changed stop state unexpectedly');
 console.log(JSON.stringify({initial,emergencyModal:modal,typedEnabled:enabled,emergencyCancelled:closed,gracefulModal:drainConfirm,stillUnchanged:true,screenshot:'master-controls-preview.png'},null,2));
 ws.close();
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{try{child.kill()}catch{}setTimeout(()=>process.exit(process.exitCode||0),200)});
