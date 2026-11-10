'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
class Deferred extends Error{constructor(code){super(code);this.code=code;}}
const digest=value=>crypto.createHash('sha256').update(Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
const ident=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);
function check(test,code){if(!test)throw new Deferred(code);}
function readJson(file,max=32*1024*1024){const st=fs.lstatSync(file);check(st.isFile()&&!st.isSymbolicLink()&&st.size<=max,'unreadable_state');return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}
function atomic(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});check(!fs.existsSync(file)||!fs.lstatSync(file).isSymbolicLink(),'redirected_state');const temp=file+'.'+crypto.randomUUID()+'.tmp',fd=fs.openSync(temp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,file);}
function within(parent,child){const rel=path.relative(path.resolve(parent),path.resolve(child));return rel===''||(!path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+path.sep));}
function realLocation(file){const absolute=path.resolve(file);let existing=absolute;const missing=[];for(;;){try{return path.join(fs.realpathSync.native(existing),...missing);}catch(error){if(error.code!=='ENOENT')throw error;const parent=path.dirname(existing);check(parent!==existing,'redirected_state');missing.unshift(path.basename(existing));existing=parent;}}}
function unredirectedDirectory(directory,{create=false,allowMissing=false}={}){
 const absolute=path.resolve(directory),root=path.parse(absolute).root,parts=absolute.slice(root.length).split(path.sep).filter(Boolean);let current=root;
 const normalized=value=>process.platform==='win32'?path.resolve(value.replace(/^\\\\\?\\/,'')).toLowerCase():path.resolve(value);
 for(const part of ['',...parts]){
  if(part)current=path.join(current,part);let st;
  try{st=fs.lstatSync(current);}catch(error){if(error.code!=='ENOENT')throw error;if(create){fs.mkdirSync(current,{mode:0o700});st=fs.lstatSync(current);}else{check(allowMissing,'private_directory_missing');return absolute;}}
  check(st.isDirectory()&&!st.isSymbolicLink(),'redirected_state');check(normalized(fs.realpathSync.native(current))===normalized(current),'redirected_state');
 }
 return absolute;
}
function privateDirectory(directory,{repositoryPath,sourceRoot=path.resolve(__dirname,'../../..'),create=false}={}){
 const resolved=unredirectedDirectory(directory,{create:false,allowMissing:true});
 for(const forbidden of [repositoryPath,sourceRoot].filter(Boolean))check(!within(realLocation(forbidden),realLocation(resolved)),'private_state_outside_source_required');
 return create?unredirectedDirectory(resolved,{create:true}):resolved;
}
function safePath(root,relative){unredirectedDirectory(root,{allowMissing:true});check(typeof relative==='string'&&relative&&!relative.includes('\0')&&!path.isAbsolute(relative)&&!/^[A-Za-z]:/.test(relative),'unsafe_archive_path');const parts=relative.replace(/\\/g,'/').split('/');check(parts.every(p=>p&&p!=='..'&&p!=='.'&&!p.includes(':')),'unsafe_archive_path');const file=path.join(root,...parts);check(within(root,file),'unsafe_archive_path');let cur=root;for(const p of parts){cur=path.join(cur,p);if(fs.existsSync(cur))check(!fs.lstatSync(cur).isSymbolicLink(),'redirected_archive_path');}return file;}
function plainError(error){return /^[a-z0-9_]{1,70}$/.test(error?.code||'')?error.code:'inspection_unavailable';}
function origin(value){const u=new URL(value);check(u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname)&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/','loopback_origin_required');return u.origin;}
function config(input,sourceRoot){
 check(input&&input.version===1&&ident(input.projectKey)&&ident(input.projectId),'invalid_project_identity');check(typeof input.repository==='string'&&/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository),'invalid_repository');
 for(const name of ['repositoryPath','statePath','controllerStatePath','aoDataPath','aoExecutable'])check(typeof input[name]==='string'&&path.isAbsolute(input[name]),'absolute_paths_required');
 privateDirectory(input.statePath,{repositoryPath:input.repositoryPath,sourceRoot});
 check(Number.isFinite(input.emergencyStopPercent)&&input.emergencyStopPercent>=0&&input.emergencyStopPercent<=99,'invalid_guard_threshold');if(input.controllerKind==='babytracker')origin(input.sharedQuotaOrigin);check(['mjobs','babytracker'].includes(input.controllerKind),'unsupported_controller');
 const limits={minAgeHours:24,maxBatch:2,maxArchiveBytes:256*1024*1024,maxFiles:30000,maxTurns:20000,retryMinutes:15,intervalMinutes:60,...input.limits};
 for(const [key,min,max]of [['minAgeHours',1,720],['maxBatch',1,5],['maxArchiveBytes',1024,1024**3],['maxFiles',1,100000],['maxTurns',1,100000],['retryMinutes',1,1440],['intervalMinutes',5,1440]])check(Number.isSafeInteger(limits[key])&&limits[key]>=min&&limits[key]<=max,'invalid_limits');
 check(typeof input.enabled==='boolean','explicit_enable_required');check(typeof input.transferToPrimary==='boolean','explicit_handoff_policy_required');return {...input,aoOrigin:origin(input.aoOrigin),controllerOrigin:origin(input.controllerOrigin),limits};
}
function identity(s){return {id:s.id,projectId:s.projectId,createdAt:s.createdAt,kind:s.kind,mode:s.mode,harness:s.harness,branch:s.branch??null,model:s.model??null,terminalGeneration:s.terminalGeneration??null};}
function assertCustodian(job,sessions){if(!job.ownerIdentity)return;const targets=sessions.filter(s=>s.id===job.owner),s=targets[0];check(targets.length===1&&s.isTerminated===false&&digest(identity(s))===digest(job.ownerIdentity)&&['idle','working','active','waiting_input'].includes(s.activity?.state)&&s.provisionState==='ready'&&s.statusReadiness==='ready','custodian_unavailable');}
function sessionVersion(s){return digest({identity:identity(s),updatedAt:s.updatedAt,activity:s.activity,isTerminated:s.isTerminated,prs:s.prs,artifacts:s.artifactFiles,branchState:s.branchState});}
module.exports={Deferred,check,ident,digest,readJson,atomic,within,safePath,plainError,origin,config,identity,sessionVersion,assertCustodian,realLocation,unredirectedDirectory,privateDirectory};
