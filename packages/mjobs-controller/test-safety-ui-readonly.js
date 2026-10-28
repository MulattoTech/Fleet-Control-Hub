'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const edge='C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const binary=fs.existsSync(edge)?edge:'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe';
const browser=spawn(binary,['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-port=9253','--remote-allow-origins=*','--user-data-dir='+path.join(__dirname,'safety-ui-check'),'--window-size=1570,1150','about:blank'],{windowsHide:true,stdio:'ignore'});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
let ws;
async function run(){
 let tab;
 for(let i=0;i<32;i++){try{tab=(await(await fetch('http://127.0.0.1:9253/json/list')).json()).find(t=>t.type==='page');if(tab)break;}catch{}await pause(250);}
 assert.ok(tab,'Headless Edge tab available');
 ws=new WebSocket(tab.webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
 let seq=0;const pending=new Map(),errors=[];
 ws.onmessage=e=>{const d=JSON.parse(e.data);if(d.method==='Runtime.exceptionThrown')errors.push(d.params.exceptionDetails.text);const x=pending.get(d.id);if(!x)return;pending.delete(d.id);d.error?x.reject(Error(d.error.message)):x.resolve(d.result);};
 const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 await send('Runtime.enable');await send('Page.enable');
 await send('Page.navigate',{url:'http://127.0.0.1:8787/'});
 const expectEmergency=(await(await fetch('http://127.0.0.1:8787/api/master')).json()).emergency.latched===true;
 let ui;
 for(let i=0;i<30;i++){
  await pause(300);
  ui=await evaluate('({rows:document.querySelectorAll("#tableRows tr").length,guard:document.querySelector("#quotaGuardStatus")?.textContent,live:document.querySelector("#quotaLive")?.textContent,weekly:document.querySelector("#quotaWeeklyValue")?.textContent,master:document.querySelector("#masterState")?.textContent,lastSync:document.querySelector("#lastSync")?.textContent,enabledActions:document.querySelectorAll("#tableRows button[data-action]:not(:disabled)").length,findWork:typeof FleetFindWorkUI})');
  if(ui.rows===29&&(expectEmergency?ui.lastSync?.includes('EMERGENCY OFFLINE')&&ui.master?.includes('STOP'):ui.guard?.includes('ARMED')&&ui.live?.includes('LIVE')))break;
 }
 assert.equal(ui.rows,29);
 if(expectEmergency){
  assert.match(ui.master,/PARTIAL STOP|AGENTS STOPPED/);
  assert.match(ui.live,/EMERGENCY TRIPPED/);
  assert.match(ui.lastSync,/EMERGENCY OFFLINE/);
  assert.equal(ui.enabledActions,0,'offline agent action buttons must be disabled');
 }else{
  assert.match(ui.guard,/ARMED.*7%/);
  assert.match(ui.live,/LIVE/);
 }
 assert.notEqual(ui.findWork,'undefined');
 assert.deepEqual(errors,[]);
 const image=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
 const screenshot=expectEmergency?'safety-emergency-20261024.png':'safety-recovery-verified.png';
 fs.writeFileSync(path.join(__dirname,screenshot),Buffer.from(image.data,'base64'));
 console.log(JSON.stringify({passed:true,readOnly:true,expectEmergency,ui,browserErrors:errors,screenshot}));
}
run().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{try{ws?.close();browser.kill();}catch{}setTimeout(()=>process.exit(process.exitCode||0),200);});
