'use strict';
// Synthetic fixtures only: no native processes, network, scheduled tasks or model turns.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {Store}=require('../src/store'),{Lifecycle}=require('../src/engine'),{classify}=require('../src/policy'),{Deferred,config,identity,readJson}=require('../src/common');
const NOW=Date.parse('2026-10-30T04:00:00Z');
function session(p={}){return {id:'example-7',projectId:'example',kind:'worker',mode:'chat',harness:'codex',model:'fixture',createdAt:'2026-10-20T00:00:00Z',updatedAt:'2026-10-27T00:00:00Z',activity:{state:'exited',lastActivityAt:'2026-10-27T00:00:00Z'},isTerminated:false,isPinned:false,provisionState:'ready',statusReadiness:'ready',branch:'ao/worker/root',branchState:{commits:0,unpushed:0},prs:[],artifactFiles:[],...p};}
function fixture(t,patch={},prs=[]){const root=fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()),'lifecycle-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));let now=NOW,claimOK=true,handoffOK=true,guardOK=true;const cfg={projectId:'example',enabled:true,transferToPrimary:true,statePath:root,limits:{minAgeHours:24,maxBatch:2,retryMinutes:15}};const s=session(patch),primary=session({id:'example-primary',kind:'orchestrator',activity:{state:'active',lastActivityAt:'2026-10-30T03:59:00Z'}}),facts={projectId:'example',complete:true,sessions:[s,primary],openPrs:prs,protectedIds:[],uncertainIds:[],replacingIds:[],taskOwners:{},ledgerEvidence:{}},calls=[];
 const adapter={inspect:async()=>facts,guard:async()=>{if(!guardOK)throw new Deferred('control_operation_active');},contentFingerprint:async()=>'content-1',claimAllowed:async()=>true,claim:async(j,n)=>calls.push(['claim',n]),claimObserved:async()=>claimOK,handoffMessage:j=>'HANDOFF '+j.custodyId,handoff:async()=>calls.push(['handoff']),handoffObserved:async()=>handoffOK,archive:async()=>{calls.push(['archive']);s.isTerminated=true;},archived:async()=>s.isTerminated};const capsules={capture:async()=>{calls.push(['capture']);return {id:'capsule',manifestSha256:'abc',sourceFingerprint:'content-1'};},verify:()=>true,handoffPath:()=>path.join(root,'capsule','manifest.json')};const store=new Store(root,'example',()=>now),engine=new Lifecycle({config:cfg,store,adapter,capsules,clock:()=>now});return {root,cfg,s,primary,facts,calls,adapter,capsules,store,engine,job:()=>Object.values(store.data.jobs)[0],claim:v=>{claimOK=v;},handoff:v=>{handoffOK=v;},guard:v=>{guardOK=v;},advance:()=>{now+=16*60000;}};}

test('receiver lost after handoff prevents artifacts-only retirement',async t=>{
 const f=fixture(t,{artifactFiles:[{path:'work.patch'}]});
 f.adapter.handoffObserved=async()=>{f.primary.isTerminated=true;return true;};
 await f.engine.run();
 assert.equal(f.s.isTerminated,false,'old worker must remain when custodian disappears before final archive');
});
test('acquiring lifecycle lock reloads prior writer committed journal',t=>{
 const f=fixture(t),second=new Store(f.root,'example',()=>NOW);
 f.store.acquire();f.store.data.jobs.receipt={id:'already-retired',stage:'archived'};f.store.save();f.store.release();
 second.acquire();
 try{assert.equal(second.data.jobs.receipt?.stage,'archived','lock owner must not overwrite committed journal with a pre-lock snapshot');}finally{second.release();}
});
test('BabyTracker guard enforces configured emergency threshold even before trip latch updates',async()=>{
 const {NativeAdapter}=require('../src/native-adapter');
 const cfg={projectId:'example',controllerKind:'babytracker',controllerOrigin:'http://127.0.0.1:3002',sharedQuotaOrigin:'http://127.0.0.1:3003',emergencyStopPercent:7};
 const adapter=new NativeAdapter(cfg);
 adapter.json=async(origin)=>origin===cfg.controllerOrigin?{projectId:'example',mode:'paused',bootstrap:{status:'complete'}}:{fresh:true,guardAcknowledged:true,config:{autoKillArmed:true,thresholdPercent:7,tripped:false},selectedRemainingPercent:7};
 await assert.rejects(()=>adapter.guard(),/quota_protection/);
});
test('capsule root symlink must not redirect private history into source',async t=>{
 const {Capsules}=require('../src/capsule');
 const root=fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()),'capsule-root-review-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const repo=path.join(root,'public-repo'),state=path.join(root,'private-state'),workspace=path.join(root,'workspace');
 for(const p of [repo,state,workspace])fs.mkdirSync(p);
 fs.writeFileSync(path.join(workspace,'note.txt'),'SYNTHETIC-PRIVATE-CONTENT');
 fs.symlinkSync(repo,path.join(state,'capsules'),process.platform==='win32'?'junction':'dir');
 const cfg={projectId:'example',statePath:state,repository:'Org/Repo',limits:{maxArchiveBytes:100000,maxFiles:100,maxTurns:100}};
 const adapter={contentFingerprint:async()=>'fixed',history:async()=>({complete:true,total:1,turns:[{userRequest:'SYNTHETIC-PRIVATE-HISTORY'}]}),workspace:async()=>({verified:true,root:workspace,worktrees:[workspace]}),gitProof:async()=>({verified:true}),gitBundle:async(dir,destination)=>fs.writeFileSync(destination,'synthetic-bundle'),artifactDirectories:async()=>[]};
 const job={key:'a'.repeat(64),openPrs:[],taskIds:[],identity:{}};
 await assert.rejects(async()=>{const capsule=new Capsules(cfg,adapter);await capsule.capture(session(),job,{ledgerEvidence:{}});},/redirected_state/);
 assert.deepEqual(fs.readdirSync(repo),[],'no private bytes may reach the redirected source destination');
});


test('parent junction or symlink cannot redirect a newly created private state path',t=>{
 const {privateDirectory}=require('../src/common');
 const root=fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()),'lifecycle-parent-link-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const repo=path.join(root,'repo'),alias=path.join(root,'external-alias');fs.mkdirSync(repo);fs.symlinkSync(repo,alias,process.platform==='win32'?'junction':'dir');
 assert.throws(()=>privateDirectory(path.join(alias,'new-private'),{repositoryPath:repo,create:true}),/redirected_state/);
 assert.deepEqual(fs.readdirSync(repo),[]);
});
test('capsule root replacement after construction is rejected before any native or private read',async t=>{
 const {Capsules}=require('../src/capsule');
 const root=fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()),'lifecycle-root-replaced-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const state=path.join(root,'private'),repo=path.join(root,'repo');fs.mkdirSync(repo);let reads=0;
 const capsule=new Capsules({statePath:state,repositoryPath:repo},{contentFingerprint:async()=>{reads++;throw Error('must not read');}});
 fs.rmdirSync(capsule.root);fs.symlinkSync(repo,capsule.root,process.platform==='win32'?'junction':'dir');
 await assert.rejects(()=>capsule.capture({},{}),/redirected_state/);assert.equal(reads,0);assert.deepEqual(fs.readdirSync(repo),[]);
});
test('repository aliases cannot hide state physically inside public source',t=>{
 const {privateDirectory}=require('../src/common');
 const root=fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()),'lifecycle-repo-alias-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const repo=path.join(root,'repo'),alias=path.join(root,'repo-alias');fs.mkdirSync(repo);fs.symlinkSync(repo,alias,process.platform==='win32'?'junction':'dir');
 assert.throws(()=>privateDirectory(path.join(repo,'private'),{repositoryPath:alias,create:true}),/outside_source/);assert.deepEqual(fs.readdirSync(repo),[]);
});
test('native archive rechecks custodian after its final guard for tasks without PRs',async()=>{
 const {NativeAdapter}=require('../src/native-adapter');const old=session(),primary=session({id:'primary',kind:'orchestrator',activity:{state:'active'}}),ownerIdentity=identity(primary);
 let nativeCalls=0;const adapter=new NativeAdapter({projectId:'example'},{runner:async()=>{nativeCalls++;return {stdout:''};}});
 adapter.guard=async()=>{primary.isTerminated=true;};adapter.sessions=async()=>[old,primary];
 await assert.rejects(()=>adapter.archive({id:old.id,identity:identity(old),owner:primary.id,ownerIdentity},old),/custodian_unavailable/);assert.equal(nativeCalls,0);
});
test('BabyTracker admission rejects below-bound, missing and nonfinite quota, while accepting above-bound',async()=>{
 const {NativeAdapter}=require('../src/native-adapter');const cfg={projectId:'example',controllerKind:'babytracker',controllerOrigin:'http://127.0.0.1:3002',sharedQuotaOrigin:'http://127.0.0.1:3003',emergencyStopPercent:7},adapter=new NativeAdapter(cfg);
 for(const remaining of [6,undefined,NaN,Infinity,8]){
  adapter.json=async origin=>origin===cfg.controllerOrigin?{projectId:'example',mode:'paused',bootstrap:{status:'complete'}}:{fresh:true,guardAcknowledged:true,config:{autoKillArmed:true,thresholdPercent:7,tripped:false},selectedRemainingPercent:remaining};
  if(remaining===8)await adapter.guard();else await assert.rejects(()=>adapter.guard(),/quota_protection/);
 }
});
