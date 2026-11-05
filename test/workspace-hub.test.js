'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createProjectRegistry,validate}=require('../src/project-registry');
const {createMissionStatus,project}=require('../src/mission-status');
const {makeServer}=require('../src/server');

test('project registration persists metadata outside Git and never installs controller rights',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-projects-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'private','projects.json'),registry=createProjectRegistry({file});
  assert.deepEqual(registry.list(),[]);
  const item=registry.add({repository:'MulattoTech/MRaiders',name:'MRaiders',workspaces:['C:\\Tools\\Dev\\MRaiders','C:\\Tools\\Dev\\MRaiders']});
  assert.deepEqual(item,{repository:'MulattoTech/MRaiders',name:'MRaiders',workspaceCount:1,kind:'read-only'});
  const reopened=createProjectRegistry({file});
  assert.deepEqual(reopened.list()[0],{repository:'MulattoTech/MRaiders',name:'MRaiders',kind:'read-only',githubUrl:'https://github.com/MulattoTech/MRaiders',workspaceCount:1});
  assert.deepEqual(reopened.list({includeLocalPaths:true})[0].workspaces,['C:\\Tools\\Dev\\MRaiders']);
  assert.equal(fs.existsSync(file),true);
  assert.throws(()=>registry.add({repository:'mulattotech/mraiders'}),/already registered/);
});

test('project input cannot register built-in controls, relative paths, traversal, or arbitrary URLs',()=>{
  for(const repository of ['MulattoTech/MJobs','MulattoTech/BabyTracker','https://github.com/MulattoTech/Test','x/../../secret','x/.git'])
    assert.throws(()=>validate({repository}),/GitHub repository/);
  for(const workspace of ['..\\secret','C:\\Tools\\Dev\\..\\secret','\\\\server\\share','foo\\bar'])
    assert.throws(()=>validate({repository:'MulattoTech/Extra',workspaces:[workspace]}),/absolute, local workspace/);
  assert.throws(()=>validate({repository:'MulattoTech/Extra',workspaces:Array(65).fill('C:\\Dev')}),/Too many/);
});

test('registry refuses aggregate byte overflow before replacing the last readable file',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-project-size-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'projects.json'),registry=createProjectRegistry({file});
  const workspaces=Array.from({length:25},(_,i)=>'C:\\Dev\\'+String(i).padStart(2,'0')+'é'.repeat(110));
  let rejected=false;
  for(let i=0;i<100;i++){
    const input={repository:'Owner/Repo'+i,workspaces};
    assert.ok(Buffer.byteLength(JSON.stringify(input))<8192,'each registration fits the HTTP body limit');
    const previous=fs.existsSync(file)?fs.readFileSync(file):null;
    try{registry.add(input);}
    catch(error){
      assert.match(error.message,/registry storage limit/);rejected=true;
      assert.deepEqual(fs.readFileSync(file),previous,'overflow cannot replace valid persisted state');
      assert.equal(createProjectRegistry({file}).list().length,i);
      assert.deepEqual(fs.readdirSync(dir),['projects.json'],'no abandoned temporary file');
      registry.add({repository:'Owner/SmallProject'});
      assert.equal(registry.list().length,i+1,'smaller additions remain possible after refusal');
      break;
    }
    assert.ok(fs.statSync(file).size<=256_000);
  }
  assert.equal(rejected,true,'the byte cap must be reached before the project-count cap');
});

test('mission progress is read-only, not inferred from PRs, and flags mismatched GitHub main',async()=>{
  const base={available:true,observed_at:'2026-11-05T12:00:00Z',original:{pass:91,partial:24,not_run:251,total:366},
    reference:{pass:8,partial:10,not_run:41,total:59},priorities:[{name:'P1',pass:72,partial:8,not_run:36,total:116}],
    areas:[{name:'Applications',pass:12,partial:4,not_run:7,total:23}],release_readiness:'PARTIAL',checkpoint_current:true,
    git:{local_main_sha:'a'.repeat(40),checkout_head_sha:'a'.repeat(40),checkout_branch:'main',github_main_sha:'b'.repeat(40)}};
  assert.equal(project(base).githubSynced,false);
  assert.match(project(base).warning,/differs from GitHub/);
  assert.equal(project(base).original.pass,91);
  assert.equal(project(base).priorities[0].pass,72);
  assert.equal(project(base).areas[0].total,23);
  assert.equal(project({...base,original:{...base.original,pass:400}}).available,false);
  const calls=[];let time=10000;
  const reader=createMissionStatus({clock:()=>time,ttlMs:5000,fetcher:async(url,opts)=>{calls.push({url,opts});return {ok:true,json:async()=>base};}});
  assert.equal((await reader.status()).available,true);await reader.status();assert.equal(calls.length,1);
  assert.equal(calls[0].url,'http://127.0.0.1:18726/api/progress');
  assert.equal(calls[0].opts.method,undefined);time+=5000;await reader.status();assert.equal(calls.length,2);
  const offline=createMissionStatus({fetcher:async()=>{throw Error('offline');}});
  assert.equal((await offline.status()).available,false);
});

test('mission source sync follows the counts checkout and never claims working-tree acceptance is published',()=>{
  const main='a'.repeat(40),feature='b'.repeat(40);
  const base={available:true,observed_at:'2026-11-05T12:00:00Z',
    original:{pass:91,partial:24,not_run:251,total:366},reference:{pass:8,partial:10,not_run:41,total:59},
    original_as_of:'2026-11-04',reference_as_of:'2026-11-03',checkpoint_current:true,
    git:{local_main_sha:main,github_main_sha:main,checkout_head_sha:feature,checkout_branch:'unmerged-feature'}};
  const divergent=project(base);
  assert.equal(divergent.localMainSynced,true);
  assert.equal(divergent.githubSynced,false);
  assert.equal(divergent.checkoutHeadSha,feature);
  assert.equal(divergent.checkoutBranch,'unmerged-feature');
  assert.match(divergent.warning,/Checked-out MJobs source differs/);
  assert.equal(divergent.originalAsOf,'2026-11-04');
  assert.equal(divergent.referenceAsOf,'2026-11-03');
  const missing=project({...base,git:{local_main_sha:main,github_main_sha:main}});
  assert.equal(missing.localMainSynced,true);
  assert.equal(missing.githubSynced,null);
  assert.match(missing.warning,/Checkout or GitHub main SHA unavailable/);
  const matched=project({...base,git:{...base.git,checkout_head_sha:main,checkout_branch:'main'}});
  assert.equal(matched.githubSynced,true);
  assert.equal(matched.publicationVerified,false);
  assert.match(matched.warning,/working-tree snapshot, not verified published acceptance/);
  const staleMain=project({...base,git:{...base.git,local_main_sha:feature,checkout_head_sha:main,checkout_branch:''}});
  assert.equal(staleMain.githubSynced,true);
  assert.equal(staleMain.localMainSynced,false);
  assert.match(staleMain.warning,/Local main also differs/);
});

test('Hub project registration is same-origin, action-token guarded and never dispatches',async()=>{
  const events=[],registered=[];
  const registry={list:({includeLocalPaths})=>registered.map(x=>({...x,...(includeLocalPaths?{workspaces:['C:\\Dev']}:{})})),
    add:input=>{events.push('register');const item=validate(input);registered.push({repository:item.repository,name:item.name,kind:'read-only',workspaceCount:item.workspaces.length});return registered.at(-1);}};
  const server=makeServer({port:4391,registry,mission:{status:async()=>({available:false})}});
  await new Promise(resolve=>server.listen(4391,'127.0.0.1',resolve));
  try{
    const base='http://127.0.0.1:4391',body=JSON.stringify({repository:'MulattoTech/FeatureStudio',workspaces:['C:\\Dev']});
    const token=(await (await fetch(base+'/api/session')).json()).token;
    const post=(origin,actionToken)=>fetch(base+'/api/projects',{method:'POST',headers:{origin,'content-type':'application/json','x-fleet-hub':actionToken},body});
    assert.equal((await post('https://evil.example',token)).status,403);
    assert.equal((await post(base,'incorrect')).status,403);assert.equal(events.length,0);
    assert.equal((await post(base,token)).status,201);assert.deepEqual(events,['register']);
    assert.equal((await (await fetch(base+'/api/projects')).json()).projects[0].workspaceCount,1);
    assert.equal((await (await fetch(base+'/api/mission-status')).json()).available,false);
    assert.equal((await fetch(base+'/workspace.js')).status,200);
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test('native pages link back to the same Hub and BabyTracker theme is generated from shared tokens',()=>{
  const repo=path.join(__dirname,'..');const read=p=>fs.readFileSync(path.join(repo,p),'utf8');
  assert.match(read('public/index.html'),/← Fleet Overview/);
  assert.match(read('packages/mjobs-controller/public/index.html'),/data-hub-home/);
  assert.match(read('packages/mjobs-controller/public/app.js'),/location\.hostname/);
  assert.match(read('packages/babytracker-controller/public/index.html'),/href="http:\/\/127\.0\.0\.1:4320\/"/);
  assert.match(read('packages/babytracker-controller/public/index.html'),/fleet-theme\.css/);
  assert.match(read('packages/babytracker-controller/public/index.html'),/src="app\.js"/);
  assert.match(read('packages/babytracker-controller/public/app.js'),/get\('api\/state'\)/);
  assert.match(read('public/workspace.js'),/link:'\/babytracker\/'/);
  assert.match(read('packages/babytracker-controller/public/fleet-theme.css'),/--fd-ground/);
  assert.match(read('public/index.html'),/id="mission-control"/);
  assert.match(read('public/index.html'),/id="add-project-form"/);
  const grafana=JSON.parse(read('packages/mjobs-controller/observability/dashboards/fleet-atlas.json'));
  assert.equal(grafana.refresh,'30s');
  assert.equal(grafana.panels.length,19);
  assert.ok(grafana.links.some(x=>x.title==='Fleet Overview'&&x.url==='https://fleet.m-techlabs.com/'));
  assert.ok(grafana.panels.filter(x=>x.type==='stat').every(x=>x.fieldConfig.defaults.color.fixedColor==='#8bbcff'));
});
