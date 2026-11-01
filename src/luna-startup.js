'use strict';
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const exec=promisify(execFile);
const CONFIG=path.join(os.homedir(),'.ao','babytracker-luna-startup.json');
const CONFIRM='START BabyTracker Master Luna';

function localConfig(file=CONFIG){
  const config=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
  if(config.projectId!=='babytracker-master' ||
     config.repository!=='https://github.com/MulattoTech/BabyTracker-Master.git' ||
     typeof config.repoPath!=='string' || !path.win32.isAbsolute(config.repoPath) ||
     !/^automation-[0-9a-f-]{36}$/.test(config.automationId||'') ||
     typeof config.quotaFile!=='string' || !path.win32.isAbsolute(config.quotaFile)) {
    throw Error('Invalid BabyTracker-Master Luna launch binding');
  }
  return config;
}
function createLunaStartup({config=localConfig,readQuota=file=>JSON.parse(fs.readFileSync(file,'utf8')),
  run=async(args)=>{const ao=path.join(os.homedir(),'AppData','Local','Programs','agent-orchestrator','resources','daemon','ao.exe');
    const {stdout}=await exec(ao,args,{windowsHide:true,timeout:10000,maxBuffer:120000});
    return JSON.parse(stdout.replace(/^\uFEFF/,''));},
  now=Date.now}={}){
  let inFlight=false;
  const pathMatches=(left,right)=>typeof left==='string'&&typeof right==='string'&&
    path.win32.normalize(left).toLowerCase()===path.win32.normalize(right).toLowerCase();
  async function preview(){
    const reasons=[];
    let binding;
    try{binding=config();}catch{return {blocked:true,blockedReasons:['Local Luna launch binding is unavailable'],confirmation:CONFIRM};}
    let project,automation,sessions,agents;
    try{
      [project,automation,sessions,agents]=await Promise.all([
        run(['project','get',binding.projectId,'--json']),
        run(['automation','get',binding.automationId,'--json']),
        run(['session','ls','--all','--project',binding.projectId,'--json']),
        run(['agent','ls','--json'])
      ]);
    }catch{return {blocked:true,blockedReasons:['AO project, automation, session or agent verification failed'],confirmation:CONFIRM};}
    const p=project?.project,a=automation?.automation;
    if(p?.id!==binding.projectId || !pathMatches(p?.path,binding.repoPath) ||
       p?.repo!==binding.repository)reasons.push('AO project/repository checkout binding changed');
    if(p?.config?.worker?.agent!=='codex' || p?.config?.orchestrator?.agent!=='codex' ||
       p?.config?.worker?.agentConfig?.model!=='gpt-6-luna' ||
       p?.config?.orchestrator?.agentConfig?.model!=='gpt-6-luna')reasons.push('Codex Luna role defaults are not configured');
    if(a?.id!==binding.automationId || a?.projectId!==binding.projectId ||
       a?.harness!=='codex' || a?.kind!=='orchestrator' ||
       typeof a?.prompt!=='string' || !a.prompt.includes('HARD LIMIT') ||
       !a.prompt.includes('gpt-6-luna'))reasons.push('Exact bounded Luna automation does not match');
    if(a?.enabled===true)reasons.push('Luna automation is already enabled');
    if(!Array.isArray(sessions?.data))reasons.push('AO session state unavailable');
    else if(sessions.data.some(s=>!s.isTerminated &&
      !['exited','terminated','stopped','failed'].includes(s.activity||s.status)))
      reasons.push('A BabyTracker-Master agent is already active; reconcile before a new start');
    if(!Array.isArray(agents?.supported) || !agents.supported.some(x=>x.id==='codex'&&x.authStatus==='authorized'))
      reasons.push('Codex harness is not authorized');
    let remainingPercent=null;
    try{
      const q=readQuota(binding.quotaFile);
      const pulse=Date.parse(q?.lastSuccessfulPoll||'');
      const windows=Array.isArray(q?.windows)?q.windows:[];
      remainingPercent=windows.length?Math.min(...windows.map(w=>w.remainingPercent)):null;
      const threshold=Math.max(7,Number(q?.config?.minimumRemainingPercent||0));
      if(!Number.isFinite(pulse)||now()-pulse>120000||now()<pulse-30000)reasons.push('Codex quota sample is stale');
      if(q?.status==='emergency_locked'||q?.config?.tripped===true||q?.ordinaryUsageAllowed===false)
        reasons.push('Shared Codex emergency lock is active');
      if(!Number.isFinite(remainingPercent)||remainingPercent<=threshold)
        reasons.push('Codex weekly allowance is at/below the protected '+threshold+'% floor');
    }catch{reasons.push('Protected Codex quota status is unavailable');}
    return {blocked:reasons.length>0,blockedReasons:reasons,confirmation:CONFIRM,
      projectId:binding.projectId,model:'gpt-6-luna',workerLimit:4,reviewerLimit:1,
      remainingPercent,enabled:a?.enabled===true};
  }
  async function start(confirmation){
    if(confirmation!==CONFIRM)throw Error('Exact Luna start confirmation required');
    if(inFlight)throw Error('Luna launch is already in progress');
    inFlight=true;
    try{
      const check=await preview();
      if(check.blocked)throw Error('Luna start blocked: '+check.blockedReasons.join('; '));
      const binding=config();
      await run(['automation','update',binding.automationId,'--enabled=true','--json']);
      const after=await run(['automation','get',binding.automationId,'--json']);
      if(after?.automation?.id!==binding.automationId||after.automation.enabled!==true)
        throw Error('AO launch outcome unverified; inspect automation before retrying');
      return {ok:true,note:'BabyTracker-Master Codex Luna loop enabled. The first scheduled tick will inspect work and dispatch within its bounded limits.'};
    }finally{inFlight=false;}
  }
  return {preview,start};
}
module.exports={createLunaStartup,localConfig,CONFIRM};
