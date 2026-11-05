'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');

function fixture(){
  const roots=new Map(),timers=new Map(),calls=[];
  let projects=[{repository:'Owner/First',name:'First',kind:'read-only',workspaceCount:1,workspaces:['C:\\Dev\\First']},
    {repository:'Owner/Second',name:'Second',kind:'read-only',workspaceCount:1,workspaces:['C:\\Dev\\Second']}];
  const mission={available:true,original:{pass:1,total:3,partial:1,notRun:1},reference:{pass:0,total:1,partial:0,notRun:1},
    areas:[{name:'Applications',pass:1,total:3,partial:1}],priorities:[],releaseReadiness:'PARTIAL',githubSynced:false};
  const document={activeElement:null,getElementById:id=>{if(!roots.has(id))roots.set(id,node('div'));return roots.get(id);},
    createElement:node,querySelector:()=>null,querySelectorAll:()=>[]};
  function node(tag){return {tag,children:[],dataset:{},className:'',open:false,handlers:{},textContent:'',
    append(...children){this.children.push(...children);},replaceChildren(...children){this.children=children;},
    addEventListener(name,fn){this.handlers[name]=fn;},setAttribute(){},focus(){document.activeElement=this;},
    querySelectorAll(selector){
      const [wanted,css]=selector.split('.'),matches=[];
      for(const child of this.children){
        if(child.tag===wanted&&(!css||child.className.split(' ').includes(css)))matches.push(child);
        matches.push(...child.querySelectorAll(selector));
      }
      return matches;
    },querySelector(selector){return this.querySelectorAll(selector)[0]||null;}};}
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/workspace.js'),'utf8'),{
    document,location:{hostname:'127.0.0.1'},AbortSignal,
    setInterval:(fn,delay)=>timers.set(delay,fn),fetch:async(url,options)=>{
      calls.push({url,options});return {ok:true,json:async()=>url==='/api/projects'?{projects}:mission};
    }
  });
  return {document,roots,timers,calls,setProjects:value=>{projects=value;},projects:()=>projects,mission};
}

test('workspace path disclosures retain per-repository open state and keyboard focus across reordered polling',async()=>{
  const f=fixture();await new Promise(setImmediate);
  const holder=f.roots.get('tracked-list'),before=holder.querySelectorAll('details.workspace-paths');
  before[0].open=true;before[0].querySelector('summary').focus();
  f.setProjects([...f.projects()].reverse());await f.timers.get(15000)();
  const after=holder.querySelectorAll('details.workspace-paths');
  assert.equal(after[0].dataset.repository,'owner/second');assert.equal(after[0].open,false);
  assert.equal(after[1].dataset.repository,'owner/first');assert.equal(after[1].open,true);
  assert.equal(f.document.activeElement,after[1].querySelector('summary'));
  after[1].open=false;await f.timers.get(15000)();
  assert.equal(holder.querySelectorAll('details.workspace-paths')[1].open,false);
  assert.ok(f.calls.every(call=>!call.options.method),'polling never dispatches actions');
});

test('Mission area disclosure remains usable across five-second metric refreshes',async()=>{
  const f=fixture();await new Promise(setImmediate);
  const holder=f.roots.get('mission-areas'),before=holder.querySelector('details.mission-area-details');
  before.open=true;before.querySelector('summary').focus();
  f.mission.areas[0].pass=2;await f.timers.get(5000)();
  const after=holder.querySelector('details.mission-area-details');
  assert.notEqual(after,before);assert.equal(after.open,true);
  assert.equal(f.document.activeElement,after.querySelector('summary'));
  assert.equal(after.querySelector('meter').value,2,'fresh values still replace the prior snapshot');
  after.open=false;await f.timers.get(5000)();
  assert.equal(holder.querySelector('details.mission-area-details').open,false);
});
