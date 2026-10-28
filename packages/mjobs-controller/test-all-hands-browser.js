'use strict';
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const chrome=fs.existsSync('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe')?'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe':'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe';
const child=spawn(chrome,['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-port=9232','--remote-allow-origins=*','--user-data-dir='+path.join(__dirname,'allhands-browser-profile'),'--window-size=1500,1050','http://127.0.0.1:8787'],{windowsHide:true,stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function test(){
 let page=null;
 for(let i=0;i<40;i++){
  try{const tabs=await(await fetch('http://127.0.0.1:9232/json/list')).json();page=tabs.find(t=>t.url.includes('127.0.0.1:8787'));if(page)break}catch{}await sleep(250)
 }
 if(!page)throw Error('Edge headless page unavailable');
 const ws=new WebSocket(page.webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});
 let next=0;const pending=new Map();
 ws.onmessage=e=>{const v=JSON.parse(e.data);if(!v.id)return;const x=pending.get(v.id);if(!x)return;pending.delete(v.id);if(v.error)x.reject(Error(v.error.message));else x.resolve(v.result)};
 const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))});
 const evaluate=async expression=>{
  const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
  if(r.exceptionDetails)throw Error('Browser JS: '+JSON.stringify(r.exceptionDetails));
  return r.result?.value;
 };
 await call('Runtime.enable');await call('Page.enable');await sleep(1600);
 const initial=await evaluate('({button:!!document.querySelector("#turboAllHands"),count:document.querySelectorAll("#tableRows tr").length,disabled:document.querySelector("#turboAllHands").disabled})');
 if(!initial.button||initial.count<25||initial.disabled)throw Error('Missing All Hands control: '+JSON.stringify(initial));
 await evaluate('document.querySelector("#turboAllHands").click()');
 for(let i=0;i<30;i++){
  const shown=await evaluate('!document.querySelector("#modalOverlay").hidden && !!document.querySelector("#confirmAllHands")');
  if(shown)break;await sleep(250)
 }
 const state=await evaluate('({shown:!document.querySelector("#modalOverlay").hidden,confirm:!!document.querySelector("#confirmAllHands"),text:document.querySelector("#modalBody").textContent.slice(0,380)})');
 if(!state.confirm||!state.text.includes('29 idle agents'))throw Error('Confirm modal incorrect: '+JSON.stringify(state));
 await evaluate('document.querySelector("[data-modal=cancel]").click()');
 const closed=await evaluate('document.querySelector("#modalOverlay").hidden');
 if(!closed)throw Error('Cancel button did not close modal');
 const stat=await(await fetch('http://127.0.0.1:8787/api/turbo')).json();
 if(stat.session?.lastAllHands)throw Error('Unexpected live dispatch');
 await evaluate('document.querySelector("#turboAllHands").scrollIntoView({block:"center"})');
 await sleep(100);
 const shot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
 fs.writeFileSync(path.join(__dirname,'all-hands-button-preview.png'),Buffer.from(shot.data,'base64'));
 console.log(JSON.stringify({initial,modal:state,closed,dispatched:false,screenshot:'all-hands-button-preview.png'},null,2));
 ws.close();
}
test().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{try{child.kill()}catch{}setTimeout(()=>process.exit(process.exitCode||0),200)});
