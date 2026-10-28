'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const edge=fs.existsSync('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe')
 ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
 : 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe';
const profile=path.join(__dirname,'test-browser-profile');
const child=spawn(edge,['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-port=9229','--remote-allow-origins=*','--user-data-dir='+profile,'--window-size=1400,900','http://127.0.0.1:8787'],{windowsHide:true,stdio:'ignore'});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function run(){
 let page;
 for(let i=0;i<35;i++){
  try{
   const tabs=await(await fetch('http://127.0.0.1:9229/json/list')).json();
   page=tabs.find(t=>t.url.includes('127.0.0.1:8787'));
   if(page)break;
  }catch{}
  await wait(250);
 }
 if(!page)throw Error('No Edge headless page found');
 const ws=new WebSocket(page.webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});
 const pending=new Map();let counter=0;
 ws.onmessage=e=>{
  const d=JSON.parse(e.data);
  if(!d.id)return;
  const task=pending.get(d.id);if(!task)return;
  pending.delete(d.id);if(d.error)task.reject(new Error(d.error.message));else task.resolve(d.result);
 };
 function send(method,params={}){
  const id=++counter;
  return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))});
 }
 async function evaluate(expression){
  const x=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
  if(x.exceptionDetails)throw Error('JS exception: '+JSON.stringify(x.exceptionDetails).slice(0,450));
  return x.result?.value;
 }
 await send('Page.enable');
 await send('Runtime.enable');
 await wait(1600);
 let rows=await evaluate('document.querySelectorAll("#tableRows tr").length');
 if(rows<20)throw Error('Fleet table did not render: '+rows);
 const hit=await evaluate('!!document.querySelector(\'[data-action="view"][data-id="mjobs-luna-31"]\')');
 if(!hit)throw Error('Target reviewer not present in UI');
 await evaluate('document.querySelector(\'[data-action="view"][data-id="mjobs-luna-31"]\').click()');
 const opened=await evaluate('!document.querySelector("#overlay").hidden');
 if(!opened)throw Error('Agent drawer did not open');
 const model=await evaluate('document.querySelector("#changeModel").value');
 const options=await evaluate('Array.from(document.querySelector("#changeModel").options).map(o=>o.value)');
 await evaluate('document.querySelector("#changeModel").value="gpt-6-astra";document.querySelector("#changeEffort").value="medium"');
 const selected=await evaluate('document.querySelector("#changeModel").value+" / "+document.querySelector("#changeEffort").value');
 const enabled=await evaluate('!document.querySelector(\'[data-action="replace"]\').disabled');
 const screenshot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
 fs.writeFileSync(path.join(__dirname,'reviewer-control-preview.png'),Buffer.from(screenshot.data,'base64'));
 console.log(JSON.stringify({tableRows:rows,drawerOpened:opened,originalModel:model,models:options,selected,replaceEnabled:enabled,screenshot:'reviewer-control-preview.png'},null,2));
 ws.close();
}
run().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{try{child.kill()}catch{};setTimeout(()=>process.exit(process.exitCode||0),150)});
