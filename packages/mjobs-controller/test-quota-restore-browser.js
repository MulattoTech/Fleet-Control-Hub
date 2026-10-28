'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const edge='C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const binary=fs.existsSync(edge)?edge:'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe';
const proc=spawn(binary,['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-port=9252','--remote-allow-origins=*','--user-data-dir='+path.join(__dirname,'quota-restore-test-browser'),'--window-size=1570,1150','http://127.0.0.1:8787'],{windowsHide:true,stdio:'ignore'});
const pause=x=>new Promise(r=>setTimeout(r,x));
async function run(){
 let page=null;
 for(let i=0;i<36;i++){try{const tabs=await(await fetch('http://127.0.0.1:9252/json/list')).json();page=tabs.find(t=>t.url.includes('127.0.0.1:8787'));if(page)break}catch{}await pause(250)}
 if(!page)throw Error('Edge debug page not found');
 const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej});
 let n=0;const waiting=new Map();
 ws.onmessage=e=>{const d=JSON.parse(e.data),task=waiting.get(d.id);if(!task)return;waiting.delete(d.id);d.error?task.reject(Error(d.error.message)):task.resolve(d.result)};
 const cmd=(method,params={})=>new Promise((resolve,reject)=>{const id=++n;waiting.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))});
 const evalJs=async exp=>{const x=await cmd('Runtime.evaluate',{expression:exp,returnByValue:true,awaitPromise:true});if(x.exceptionDetails)throw Error(JSON.stringify(x.exceptionDetails).slice(0,300));return x.result?.value};
 await cmd('Runtime.enable');await cmd('Page.enable');await pause(1800);
 let count;
 for(let i=0;i<30;i++){
  count=await evalJs('({quota:document.querySelector("#quotaLive")?.textContent,rows:document.querySelectorAll("#tableRows tr").length,restore:!!document.querySelector("#masterRestore"),guard:!!document.querySelector("#quotaArm")})');
  if(count.rows>=24&&count.restore&&count.guard&&count.quota&&count.quota!=='Connecting…')break;
  await pause(280);
 }
 if(!count.restore||!count.guard||count.rows<24)throw Error('Dashboard UI not initialized '+JSON.stringify(count));
 const q=await(await fetch('http://127.0.0.1:8787/api/quota')).json();
 const m=await(await fetch('http://127.0.0.1:8787/api/master')).json();
 if(m.emergency.latched||m.drain.enabled||m.restore.active)throw Error('Current AO is in an unsafe state for UI-only checks');
 await evalJs('document.querySelector("#masterRestore").click()');
 for(let i=0;i<20;i++){if(await evalJs('!!document.querySelector("#restorePhrase")'))break;await pause(250)}
 const restoreModal=await evalJs('({open:!document.querySelector("#modalOverlay").hidden,field:!!document.querySelector("#restorePhrase"),disabled:document.querySelector("#confirmRestore")?.disabled})');
 if(!restoreModal.open||!restoreModal.field||!restoreModal.disabled)throw Error('Restore modal missing '+JSON.stringify(restoreModal));
 await evalJs('document.querySelector("[data-modal=cancel]").click()');
 await evalJs('document.querySelector("#quotaSection").scrollIntoView({block:"start",behavior:"instant"})');
 await pause(120);
 const image=await cmd('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
 fs.writeFileSync(path.join(__dirname,'quota-restore-preview.png'),Buffer.from(image.data,'base64'));
 if(q.fresh){
  await evalJs('document.querySelector("#quotaArm").click()');
  const armedConfirm=await evalJs('({modal:!document.querySelector("#modalOverlay").hidden,field:!!document.querySelector("#quotaArmPhrase"),disabled:document.querySelector("#quotaArmConfirm")?.disabled})');
  if(!armedConfirm.modal||!armedConfirm.field||!armedConfirm.disabled)throw Error('Auto-kill confirmation missing '+JSON.stringify(armedConfirm));
  await evalJs('document.querySelector("[data-modal=cancel]").click()');
 }
 const end=await(await fetch('http://127.0.0.1:8787/api/master')).json();
 const quota=await(await fetch('http://127.0.0.1:8787/api/quota')).json();
 if(end.emergency.latched||end.drain.enabled||end.restore.active||quota.config.autoKillArmed)throw Error('A test unexpectedly changed production state');
 console.log(JSON.stringify({ui:count,quotaFresh:q.fresh,availableUsage:q.selectedRemainingPercent,restoreModal,untouched:true,screenshot:'quota-restore-preview.png'}));
 ws.close();
}
run().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{try{proc.kill()}catch{}setTimeout(()=>process.exit(process.exitCode||0),190)});
