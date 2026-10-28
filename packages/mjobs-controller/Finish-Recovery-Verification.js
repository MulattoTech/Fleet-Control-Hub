'use strict';
const fs=require('node:fs'),path=require('node:path');
const {RestoreFleet}=require('./restore-fleet');
const root=__dirname;
(async()=>{
 const q=await(await fetch('http://127.0.0.1:8787/api/quota')).json();
 if(!q.fresh||!q.config.autoKillArmed||q.config.thresholdPercent!==7||q.selectedRemainingPercent<=7)throw Error('7% safety preflight failed');
 const restore=new RestoreFleet({root,autoSchedule:false,locked:()=>JSON.parse(fs.readFileSync(path.join(root,'emergency-latch.json'),'utf8').replace(/^\uFEFF/,'' )).enabled===true,dispatchOff:()=>{},command:async()=>{throw Error('Verification-only run cannot launch agents')},audit:(event,data)=>fs.appendFileSync(path.join(root,'audit.jsonl'),JSON.stringify({time:new Date().toISOString(),event,...data})+'\n')});
 const p=await restore.preview();
 if(p.totalTargets!==29||p.alreadyOnline!==29||p.rootConflicts.length)throw Error('Expected 29 verified-online MJobs agents, got '+JSON.stringify({targets:p.totalTargets,online:p.alreadyOnline,conflicts:p.rootConflicts}));
 restore.start({autoDispatchAfter:false,manifest:restore.getSnapshot(),fromEmergency:false});
 const out=await restore.tick();
 if(!out.complete||out.restored!==29)throw Error('Verification failed: '+JSON.stringify(out));
 restore.schedule();
 console.log(JSON.stringify({complete:out.complete,verifiedRuntimes:out.restored,phase:restore.status().phase,quotaArmed:q.config.autoKillArmed,threshold:q.config.thresholdPercent}));
})().catch(e=>{console.error(e);process.exitCode=1});
