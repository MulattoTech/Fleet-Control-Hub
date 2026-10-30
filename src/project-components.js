'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {config,readJson,atomic,check,digest,ident}=require('../packages/session-lifecycle/src/common');
function defaultRegistry(){return process.env.FLEET_HUB_PROFILES||path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'.local','share'),'FleetControlHub','project-components.json');}
function createProjectComponents({file=defaultRegistry(),clock=Date.now}={}){
 function load(){if(!fs.existsSync(file))return {version:1,projects:[]};const v=readJson(file,1024*1024);check(v.version===1&&Array.isArray(v.projects)&&v.projects.length<=32&&new Set(v.projects.map(p=>p.projectKey)).size===v.projects.length,'invalid_project_registry');return v;}
 function status(){const registry=load();return {version:1,observedAt:new Date(clock()).toISOString(),revision:digest(registry),projects:registry.projects.map(raw=>{
  const cfg=config(raw),features={fleetControl:raw.features?.fleetControl!==false,missionControl:raw.features?.missionControl===true,sessionLifecycle:raw.features?.sessionLifecycle!==false};let latest=null,service=null;
  try{latest=readJson(path.join(cfg.statePath,'summary.json'));check(latest.projectId===cfg.projectId,'status_project_mismatch');}catch{latest=null;}try{service=readJson(path.join(cfg.statePath,'service-status.json'));}catch{}
  const age=clock()-Date.parse(latest?.observedAt||''),fresh=Number.isFinite(age)&&age>=0&&age<=(cfg.limits.intervalMinutes*2+20)*60000,failedNewer=service&&(!latest||Date.parse(service.observedAt)>Date.parse(latest.observedAt));
  return {id:cfg.projectKey,projectId:cfg.projectId,repository:cfg.repository,enabled:cfg.enabled,features,housekeeping:{mode:!cfg.enabled||!features.sessionLifecycle?'off':failedNewer?'retrying':!latest?'configured':fresh?'last-check-complete':'stale-observation',lastRunAt:latest?.observedAt||null,intervalMinutes:cfg.limits.intervalMinutes,counts:latest?.counts||{},processed:latest?.processed??null,deferred:(latest?.jobs||[]).filter(j=>j.reason).length,jobs:(latest?.jobs||[]).slice(-200).map(j=>({id:j.id,stage:j.stage,owner:j.owner||null,reason:j.reason||null,retryAt:j.retryAt||null,openPrs:j.openPrs||[]}))}};
 })};}
 function saveFeatures({id,features,expectedRevision,confirmation}){check(ident(id)&&confirmation==='SAVE PROJECT COMPONENTS'&&features&&Object.keys(features).sort().join(',')==='fleetControl,missionControl,sessionLifecycle'&&Object.values(features).every(v=>typeof v==='boolean'),'invalid_component_selection');check(features.fleetControl||!features.sessionLifecycle,'lifecycle_requires_fleet');const registry=load();check(digest(registry)===expectedRevision,'project_configuration_changed');const matching=registry.projects.filter(p=>p.projectKey===id);check(matching.length===1,'unknown_project');matching[0].features=features;atomic(file,registry);return {ok:true,...status(),nativeWorkSubmitted:false};}
 return {status,saveFeatures};
}
module.exports={createProjectComponents,defaultRegistry};
