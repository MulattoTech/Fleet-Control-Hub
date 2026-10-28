'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const edge='C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const browser=fs.existsSync(edge)?edge:'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe';
const profile=path.join(__dirname,'turbo-ui-test-profile');
const child=spawn(browser,['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-port=9231','--remote-allow-origins=*','--user-data-dir='+profile,'--window-size=1550,1150','http://127.0.0.1:8787'],{windowsHide:true,stdio:'ignore'});
const sleep=t=>new Promise(r=>setTimeout(r,t));
async function run(){
 let page;
 for(let i=0;i<38;i++){
  try{const tabs=await(await fetch('http://127.0.0.1:9231/json/list')).json();page=tabs.find(t=>t.url.includes('127.0.0.1:8787'));if(page)break}catch{}
  await sleep(250);
 }
 if(!page)throw Error('Headless Edge page unavailable');
 const ws=new WebSocket(page.webSocketDebuggerUrl);
 await new Promise((ok,fail)=>{ws.onopen=ok;ws.onerror=fail});
 let n=0;const promises=new Map();
 ws.onmessage=e=>{const v=JSON.parse(e.data);if(!v.id)return;const x=promises.get(v.id);if(!x)return;promises.delete(v.id);if(v.error)x.fail(Error(v.error.message));else x.ok(v.result)};
 const call=(method,params={})=>new Promise((ok,fail)=>{const id=++n;promises.set(id,{ok,fail});ws.send(JSON.stringify({id,method,params}))});
 const evalJs=async expression=>{
  const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
  if(r.exceptionDetails)throw Error('Browser JS error: '+JSON.stringify(r.exceptionDetails).slice(0,300));
  return r.result?.value;
 };
 await call('Runtime.enable');await call('Page.enable');
 await sleep(1800);
 const data=await evalJs('({agentRows:document.querySelectorAll("#tableRows tr").length,turboPresent:!!document.querySelector("#turboSection"),turboStatus:document.querySelector("#turboStatus").textContent,planText:document.querySelector("#turboPlan").textContent.slice(0,260),target:document.querySelector("#turboTarget").textContent})');
 if(!data.turboPresent||data.agentRows<25)throw Error('Fleet and Turbo UI failed: '+JSON.stringify(data));
 await evalJs('document.querySelector("#openTurbo").click()');
 await sleep(350);
 const visible=await evalJs('document.querySelector("#turboSection").getBoundingClientRect().top<400');
 if(!visible)throw Error('Sidebar link did not scroll to Turbo');
 await evalJs('document.querySelector("#turboSection").scrollIntoView({block:"start",behavior:"instant"})');
 await sleep(200);
 const snap=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
 fs.writeFileSync(path.join(__dirname,'turbo-dashboard-preview.png'),Buffer.from(snap.data,'base64'));
 await evalJs('document.querySelector("#turboToggle").click()');
 const dialog=await evalJs('(!document.querySelector("#modalOverlay").hidden)&&!!document.querySelector("#enableTurboConfirmed")');
 if(!dialog)throw Error('Turbo enable confirmation did not appear');
 await evalJs('document.querySelector("[data-modal=cancel]").click()');
 const closed=await evalJs('document.querySelector("#modalOverlay").hidden');
 if(!closed)throw Error('Cancel did not close Turbo modal');
 const state=await(await fetch('http://127.0.0.1:8787/api/turbo')).json();
 if(state.config.enabled)throw Error('Preview test unexpectedly enabled Turbo');
 console.log(JSON.stringify({...data,navScroll:true,enableConfirmation:true,cancelWorks:closed,remainsDisabled:!state.config.enabled,screenshot:'C:\\Tools\\AO-Fleet-Control\\turbo-dashboard-preview.png'},null,2));
 ws.close();
}
run().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{try{child.kill()}catch{}setTimeout(()=>process.exit(process.exitCode||0),250)});
