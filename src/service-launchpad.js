'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {spawn,execFile}=require('node:child_process');
const {promisify}=require('node:util');
const run=promisify(execFile);
const PLEX='C:\\Program Files\\Plex\\Plex Media Server\\Plex Media Server.exe';
const DOCKER='C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe';
const MONAI=process.env.USERPROFILE?path.join(process.env.USERPROFILE,'monai-service','start_service.vbs'):'';
const TASKS=Object.freeze({'rustdesk-restart':'Fleet Hub - Restart RustDesk','tailscale-restart':'Fleet Hub - Restart Tailscale'});
const auditPath=process.env.LOCALAPPDATA?path.join(process.env.LOCALAPPDATA,'FleetControlHub','service-actions.jsonl'):'';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function createServiceLaunchpad({processRun=run,launch=spawn,auditFile=auditPath,plexPath=PLEX,dockerPath=DOCKER,monaiPath=MONAI}={}){
  const inFlight=new Set(),lastAction=new Map();
  async function namedProcess(name){
    const {stdout}=await processRun('tasklist.exe',['/FI','IMAGENAME eq '+name,'/FO','CSV','/NH'],{windowsHide:true,timeout:5000});
    return stdout.split(/\r?\n/).some(line=>line.trim().toLowerCase().startsWith('"'+name.toLowerCase()+'",'));
  }
  async function serviceState(name){
    const {stdout}=await processRun('sc.exe',['query',name],{windowsHide:true,timeout:5000});
    return /STATE\s*:\s*\d+\s+RUNNING/i.test(stdout)?'running':/STATE\s*:\s*\d+\s+STOPPED/i.test(stdout)?'stopped':'unknown';
  }
  async function brokerReady(action){
    try{await processRun('schtasks.exe',['/Query','/TN',TASKS[action]],{windowsHide:true,timeout:5000});return true;}catch{return false;}
  }
  async function dockerHealthy(){
    if(!fs.existsSync(dockerPath))return false;
    try{const {stdout}=await processRun(dockerPath,['info','--format','{{.ServerVersion}}'],{windowsHide:true,timeout:7000});return /^\d+\.\d+/.test(stdout.trim());}catch{return false;}
  }
  async function status(){
    const [plex,monai,docker,rustdesk,tailscale,rustdeskBroker,tailscaleBroker]=await Promise.all([
      namedProcess('Plex Media Server.exe'),namedProcess('mediamtx.exe'),dockerHealthy(),serviceState('RustDesk'),serviceState('Tailscale'),brokerReady('rustdesk-restart'),brokerReady('tailscale-restart')]);
    return {plex:{running:plex,canStart:fs.existsSync(plexPath)},rustdesk:{state:rustdesk,canRestart:rustdeskBroker},tailscale:{state:tailscale,canRestart:tailscaleBroker},docker:{healthy:docker,canStart:fs.existsSync(dockerPath),canRestart:fs.existsSync(dockerPath)},monai:{gatewayRunning:monai,canStart:fs.existsSync(monaiPath)}};
  }
  function audit(event){
    if(!auditFile||!path.isAbsolute(auditFile))throw Error('Audit destination unavailable');
    fs.mkdirSync(path.dirname(auditFile),{recursive:true,mode:0o700});
    fs.appendFileSync(auditFile,JSON.stringify({at:new Date().toISOString(),...event})+'\n',{mode:0o600});
  }
  async function guarded(action,fn){
    const key=action.startsWith('docker-')?'docker':action;
    if(inFlight.has(key))throw Error('Action already in progress');
    if(Date.now()-(lastAction.get(key)||0)<60000)throw Error('Action cooldown active');
    inFlight.add(key);lastAction.set(key,Date.now());
    try{audit({action,outcome:'requested'});const result=await fn();audit({action,outcome:'accepted'});return result;}
    catch(e){audit({action,outcome:'failed',error:String(e.message).slice(0,120)});throw e;}
    finally{inFlight.delete(key);}
  }
  async function startPlex(){
    if(!fs.existsSync(plexPath))throw Error('Plex executable unavailable');
    if(await namedProcess('Plex Media Server.exe'))return {ok:true,note:'Plex is already running'};
    return guarded('plex-start',async()=>{
      await new Promise((resolve,reject)=>{const child=launch(plexPath,[],{detached:true,windowsHide:true,stdio:'ignore'});child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});});
      return {ok:true,note:'Plex start requested; refresh status to confirm'};
    });
  }
  async function restartService(action){
    if(!await brokerReady(action))throw Error('Service recovery broker has not been installed');
    return guarded(action,async()=>{
      await processRun('schtasks.exe',['/Run','/TN',TASKS[action]],{windowsHide:true,timeout:5000});
      return {ok:true,note:'Service recovery requested; the remote connection may briefly disconnect'};
    });
  }
  async function startDocker(){
    if(!fs.existsSync(dockerPath))throw Error('Docker Desktop unavailable');
    if(await dockerHealthy())return {ok:true,note:'Docker engine is already healthy'};
    return guarded('docker-start',async()=>{
      await processRun(dockerPath,['desktop','start','--detach'],{windowsHide:true,timeout:15000});
      return {ok:true,note:'Docker Desktop start requested; refresh status to confirm engine health'};
    });
  }
  async function restartDocker(){
    if(!fs.existsSync(dockerPath))throw Error('Docker Desktop unavailable');
    if(!await dockerHealthy())return startDocker();
    return guarded('docker-restart',async()=>{
      await processRun(dockerPath,['desktop','stop','--timeout','60'],{windowsHide:true,timeout:75000});
      await processRun(dockerPath,['desktop','start','--detach'],{windowsHide:true,timeout:15000});
      return {ok:true,note:'Docker Desktop restart requested; containers may be interrupted. Refresh status to confirm'};
    });
  }
  async function startMonai(){
    if(!fs.existsSync(monaiPath))throw Error('Monai gateway launcher unavailable');
    if(await namedProcess('mediamtx.exe'))return {ok:true,note:'Monai gateway is already running; stream health requires local inspection'};
    return guarded('monai-start',async()=>{
      await processRun('wscript.exe',['//B','//Nologo',monaiPath],{windowsHide:true,timeout:10000});
      for(let i=0;i<5;i++){await pause(1000);if(await namedProcess('mediamtx.exe'))return {ok:true,note:'Monai gateway started; verify the camera stream locally'};}
      throw Error('Monai gateway did not appear after start');
    });
  }
  async function act(action){
    if(action==='plex-start')return startPlex();
    if(action==='rustdesk-restart'||action==='tailscale-restart')return restartService(action);
    if(action==='docker-start')return startDocker();
    if(action==='docker-restart')return restartDocker();
    if(action==='monai-start')return startMonai();
    throw Error('Unknown service action');
  }
  return {status,act,audit};
}
module.exports={createServiceLaunchpad,TASKS};
