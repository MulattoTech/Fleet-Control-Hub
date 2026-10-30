#!/usr/bin/env node
'use strict';
const path=require('node:path');
const {config,readJson,atomic,check,plainError}=require('../src/common');
const {Store}=require('../src/store');const {Lifecycle}=require('../src/engine');const {NativeAdapter}=require('../src/native-adapter');const {Capsules}=require('../src/capsule');
async function main(args=process.argv.slice(2)){
 check(args.length>=2&&args[0]==='--config'&&args.slice(2).every(x=>x==='--dry-run')&&path.isAbsolute(args[1]),'explicit_configuration_required');const registry=readJson(args[1],1024*1024);
 check(registry.version===1&&Array.isArray(registry.projects)&&registry.projects.length<=32,'invalid_project_registry');check(new Set(registry.projects.map(p=>p.projectId)).size===registry.projects.length&&new Set(registry.projects.map(p=>p.projectKey)).size===registry.projects.length&&new Set(registry.projects.map(p=>p.statePath?.toLowerCase())).size===registry.projects.length,'project_state_collision');const reports=[];
 for(const input of registry.projects){
  const cfg={...config(input,path.resolve(__dirname,'../../..')),registryFile:args[1]};if(!cfg.enabled||cfg.features?.fleetControl===false||cfg.features?.sessionLifecycle===false){reports.push({projectId:cfg.projectId,enabled:false});continue;}
  const adapter=new NativeAdapter(cfg),store=new Store(cfg.statePath,cfg.projectId),capsules=new Capsules(cfg,adapter);
  try{const result=await new Lifecycle({config:cfg,store,adapter,capsules}).run({dryRun:args.includes('--dry-run')});atomic(path.join(cfg.statePath,args.includes('--dry-run')?'preview.json':'summary.json'),result);reports.push({projectId:cfg.projectId,processed:result.processed,eligible:result.eligible,counts:result.counts});}
  catch(e){const report={version:1,projectId:cfg.projectId,observedAt:new Date().toISOString(),mode:'retrying',reason:plainError(e),retryAfterMinutes:cfg.limits.retryMinutes};atomic(path.join(cfg.statePath,'service-status.json'),report);reports.push(report);}
 }
 process.stdout.write(JSON.stringify({observedAt:new Date().toISOString(),reports})+'\n');return reports;
}
if(require.main===module)main().catch(e=>{process.stderr.write(plainError(e)+'\n');process.exitCode=1;});
module.exports={main};
