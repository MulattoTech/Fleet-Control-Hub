'use strict';
// Configuration registration only: this command does not provision controllers or start agents.
const fs=require('node:fs'),path=require('node:path');
const {config,readJson,atomic,check,digest}=require('../packages/session-lifecycle/src/common');
function attach(registryFile,profileFile,{apply=false}={}){
 check(path.isAbsolute(registryFile)&&path.isAbsolute(profileFile),'absolute_paths_required');
 const input=readJson(profileFile,1024*1024),profile=config(input,path.resolve(__dirname,'..'));
 check(profile.features&&['fleetControl','missionControl','sessionLifecycle'].every(k=>typeof profile.features[k]==='boolean'),'explicit_component_selection_required');check(profile.features.fleetControl||!profile.features.sessionLifecycle,'lifecycle_requires_fleet');
 const registry=fs.existsSync(registryFile)?readJson(registryFile,1024*1024):{version:1,projects:[]};check(registry.version===1&&Array.isArray(registry.projects)&&registry.projects.length<32,'invalid_project_registry');
 check(!registry.projects.some(p=>p.projectKey===profile.projectKey||p.projectId===profile.projectId||p.statePath.toLowerCase()===profile.statePath.toLowerCase()),'project_already_registered');
 const next={...registry,projects:[...registry.projects,input]};if(apply)atomic(registryFile,next);
 return {applied:apply,project:profile.projectKey,features:profile.features,revision:digest(next),nativeWorkSubmitted:false};
}
if(require.main===module){try{const [registry,profile,...flags]=process.argv.slice(2);check(flags.every(f=>f==='--apply'),'unknown_flag');console.log(JSON.stringify(attach(registry,profile,{apply:flags.includes('--apply')})));}catch(e){console.error(e.code||'project_registration_failed');process.exitCode=1;}}
module.exports={attach};
