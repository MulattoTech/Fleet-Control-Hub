'use strict';
// Project discovery is metadata only. Registration never clones a repository,
// traverses a workspace, or installs a controller.
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {randomUUID}=require('node:crypto');

const REPO=/^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/;
const BUILTIN=new Set(['mulattotech/mjobs','mulattotech/babytracker']);
const MAX_PROJECTS=100,MAX_WORKSPACES=64;
const defaultFile=()=>path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'.config'),'FleetControlHub','tracked-projects.json');

function validate(input){
  if(!input||Array.isArray(input)||typeof input!=='object'||Object.keys(input).some(k=>!['repository','name','workspaces'].includes(k)))
    throw Error('Provide a repository, name and optional workspace paths.');
  const repository=String(input.repository||'').trim();
  if(!REPO.test(repository)||repository.includes('..')||repository.endsWith('.git')||BUILTIN.has(repository.toLowerCase()))
    throw Error('Provide a new GitHub repository as owner/name; MJobs and BabyTracker are already managed.');
  const name=String(input.name||repository.split('/')[1]).trim();
  if(!name||name.length>80||/[\x00-\x1f\x7f<>]/.test(name))throw Error('Project name must be 1–80 readable characters.');
  if(input.workspaces!==undefined&&!Array.isArray(input.workspaces))throw Error('Workspaces must be a list.');
  const incoming=input.workspaces||[];
  if(incoming.length>MAX_WORKSPACES)throw Error('Too many workspace paths for one project.');
  const workspaces=[];
  for(const value of incoming){
    if(typeof value!=='string')throw Error('Workspace paths must be text.');
    const item=value.trim();
    if(item.length>240||/[\x00-\x1f\x7f]/.test(item)||!(path.win32.isAbsolute(item)||path.posix.isAbsolute(item))||
       item.startsWith('\\\\')||item.split(/[\\/]/).includes('..'))throw Error('Use an absolute, local workspace path without traversal.');
    if(!workspaces.some(p=>p.toLowerCase()===item.toLowerCase()))workspaces.push(item);
  }
  return {repository,name,workspaces};
}

function createProjectRegistry({file=defaultFile()}={}){
  function read(){
    try{
      const stat=fs.lstatSync(file);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size>256_000)throw Error('Project registry is unsafe or oversized.');
      const data=JSON.parse(fs.readFileSync(file,'utf8'));
      if(data?.version!==1||!Array.isArray(data.projects)||data.projects.length>MAX_PROJECTS)throw Error('Invalid project registry.');
      const projects=data.projects.map(validate);
      if(new Set(projects.map(p=>p.repository.toLowerCase())).size!==projects.length)throw Error('Duplicate project registry entries.');
      return projects;
    }catch(e){if(e.code==='ENOENT')return [];throw e;}
  }
  function list({includeLocalPaths=false}={}){
    return read().map(p=>({repository:p.repository,name:p.name,kind:'read-only',
      githubUrl:'https://github.com/'+p.repository,
      workspaceCount:p.workspaces.length,
      ...(includeLocalPaths?{workspaces:p.workspaces}:{})}));
  }
  function add(input){
    const project=validate(input),projects=read();
    if(projects.length>=MAX_PROJECTS)throw Error('Project registry limit reached.');
    if(projects.some(p=>p.repository.toLowerCase()===project.repository.toLowerCase()))throw Error('Project is already registered.');
    const dir=path.dirname(file);fs.mkdirSync(dir,{recursive:true,mode:0o700});
    const temp=file+'.'+randomUUID()+'.tmp';
    try{
      fs.writeFileSync(temp,JSON.stringify({version:1,projects:[...projects,project]},null,2)+'\n',{flag:'wx',mode:0o600});
      fs.renameSync(temp,file);
    }finally{try{fs.unlinkSync(temp);}catch(e){if(e.code!=='ENOENT')throw e;}}
    return {repository:project.repository,name:project.name,workspaceCount:project.workspaces.length,kind:'read-only'};
  }
  return {list,add};
}
module.exports={createProjectRegistry,validate};
