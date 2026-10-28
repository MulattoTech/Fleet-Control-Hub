'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),os=require('node:os'),fs=require('node:fs'),path=require('node:path');
const {FleetController}=require('../controller');
const {PROJECT,SOURCE_REPO,ISSUE_REPO}=require('../config');
const catalog={providers:[
 {id:'codex',name:'Codex',available:true,models:[{id:'gpt-6-sol',name:'Sol',efforts:['medium','high'],defaultEffort:'medium',effortMode:'flag'}]},
 {id:'agy',name:'AGY',available:true,models:[{id:'gemini-3.8-flash-high',name:'Gemini High',efforts:['high'],defaultEffort:'high',effortMode:'model-id'}]}
]};
function fakeSession({mode='chat',harness='codex',working=false,kind='worker'}={}){return {id:'baby-worker-1',projectId:PROJECT,kind,harness,model:mode==='chat'?null:'gpt-6-luna',mode,
 displayName:'BabyTracker Worker',activity:{state:working?'active':'idle'},isTerminated:false,createdAt:'2026-10-27T12:00:00Z',prs:[]};}
function fixture(t,options={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'baby-model-change-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const state={session:fakeSession(options),quota:{fresh:true,remainingPercent:75},agy:{fresh:false,remainingPercent:null},commands:[],writes:[],phase:null, ...options};
 const native={
  session:async id=>{assert.equal(id,state.session.id);return structuredClone(state.session)},
  conversation:async()=>({sessionId:state.session.id,harness:'codex',settings:{model:'gpt-6-sol',reasoningEffort:'high'}}),
  patchChat:async(id,plan,reserve)=>{
   reserve();state.writes.push({kind:'PATCH',id,model:plan.model,effort:plan.effort});
   return {status:'applied_next_turn',note:'Applied to next turn without stopping active work.'};
  },
  transition:async()=>({supported:true,targetMode:state.session.mode==='chat'?'tui':'chat',transition:state.phase}),
  startTransition:async(id,target,reserve)=>{
   reserve();state.writes.push({kind:'TRANSITION',id,target,policy:'drain'});
   state.phase={id:'switch-t1',phase:'draining',targetMode:target};
   return state.phase;
  },
  switchProvider:async(id,plan,req,reserve)=>{
   reserve();state.writes.push({kind:'PROVIDER',id,model:plan.model,harness:plan.harness});
   state.session={...state.session,harness:plan.harness,model:plan.model,mode:'tui',activity:{state:'idle'}};
   return {status:'applied',note:'Verified same-session provider switch.'};
  }
 };
 const adapter={sessions:async()=>[structuredClone(state.session),{id:'mjobs-other',projectId:'mjobs-luna',harness:'codex',activity:{state:'idle'}}],command:async(...args)=>{state.commands.push(args);return {submitted:true}}};
 const config={projectId:PROJECT,sourceRepository:SOURCE_REPO,issueRepository:ISSUE_REPO,stateDir:dir,runtimeVerified:true};
 const deps={adapter,nativeModel:native,providers:async()=>catalog,quota:()=>state.quota,agyUsage:async()=>state.agy,resources:()=>({freeMemoryGiB:15,totalMemoryGiB:64})};
 const controller=new FleetController(config,deps);
 return{controller,state,native,adapter,config,deps};
}
const codex={harness:'codex',model:'gpt-6-sol',effort:'high',mode:'chat'};
const agy={harness:'agy',model:'gemini-3.8-flash-high',effort:'high',mode:'tui',acknowledgeUnknownAgyQuota:true};
test('Codex Chat saves next-turn model immediately DURING an active turn, without interrupt or worktree mutation',async t=>{
 const f=fixture(t,{working:true});const result=await f.controller.changeModel('baby-worker-1',codex);
 assert.equal(result.status,'applied_next_turn');
 assert.equal(f.state.writes.length,1);assert.equal(f.state.writes[0].kind,'PATCH');
 assert.equal(f.state.session.activity.state,'active');assert.equal(f.state.commands.length,0);
 assert.equal(f.controller.state.plans['baby-worker-1'].status,'applied_next_turn');
});
test('Busy Codex Chat -> AGY is queued, preserves the active turn, transitions with drain after idle',async t=>{
 const f=fixture(t,{working:true});const result=await f.controller.changeModel('baby-worker-1',agy);
 assert.equal(result.status,'queued');assert.equal(f.state.writes.length,0);assert.equal(f.state.commands.length,0);
 // Existing fleet guard still protects from dispatch to a queued-switch session.
 await f.controller.start(); await assert.rejects(f.controller.dispatch('baby-worker-1'),/idle|model handoff/);
 await f.controller.tick();assert.equal(f.state.writes.length,0);
 f.state.session.activity.state='idle';
 await assert.rejects(f.controller.dispatch('baby-worker-1'),/model handoff/);
 await f.controller.tick();assert.equal(f.state.writes[0].kind,'TRANSITION');
 assert.equal(f.controller.state.plans['baby-worker-1'].status,'transitioning');
 await f.controller.tick();assert.equal(f.state.writes.length,1);
 f.state.session.mode='tui';f.state.phase={id:'switch-t1',phase:'completed',targetMode:'tui'};
 await f.controller.tick();assert.equal(f.state.writes[1].kind,'PROVIDER');
 assert.equal(f.controller.state.plans['baby-worker-1'].status,'applied');
 assert.equal(f.state.session.harness,'agy');assert.equal(f.state.session.id,'baby-worker-1');
 assert.equal(f.state.commands.length,0);
});
test('Codex Terminal same provider uses supported TUI -> Chat drain and sets model for next turn',async t=>{
 const f=fixture(t,{mode:'tui'});const queued=await f.controller.changeModel('baby-worker-1',codex);
 assert.equal(queued.status,'queued');assert.equal(f.state.writes.length,0);
 await f.controller.start();await f.controller.tick();
 assert.equal(f.state.writes[0].kind,'TRANSITION');assert.equal(f.state.writes[0].target,'chat');
 f.state.session.mode='chat';f.state.phase={id:'switch-t1',phase:'completed',targetMode:'chat'};
 await f.controller.tick();
 assert.equal(f.state.writes[1].kind,'PATCH');
 assert.equal(f.controller.state.plans['baby-worker-1'].status,'applied_next_turn');
 assert.equal(f.state.commands.length,0);
});
test('Same AGY TUI model changes are honestly refused, not silently staged',async t=>{
 const f=fixture(t,{harness:'agy',mode:'tui'});
 await assert.rejects(f.controller.changeModel('baby-worker-1',agy),/cannot change models inside the same/);
 assert.equal(f.state.writes.length,0);
});
test('Orchestrator cross-provider handoff requires explicit acknowledgement',async t=>{
 const f=fixture(t,{kind:'orchestrator'});
 await assert.rejects(f.controller.changeModel('baby-worker-1',{...agy,acknowledgeOrchestratorHandoff:false}),/Orchestrator provider handoff/);
 assert.equal(f.state.writes.length,0);
});
test('queued changes survive to restart as manual resume, without auto-restarting paid work',async t=>{
 const f=fixture(t,{working:true,mode:'tui'});await f.controller.changeModel('baby-worker-1',codex);
 assert.equal(f.controller.state.plans['baby-worker-1'].status,'queued');
 const restarted=new FleetController(f.config,f.deps);
 assert.equal(restarted.state.mode,'paused');
 assert.equal(restarted.state.plans['baby-worker-1'].status,'resume_required');
 await restarted.tick();assert.equal(f.state.writes.length,0);
 await restarted.resumeModelChange('baby-worker-1');
 assert.equal(restarted.state.plans['baby-worker-1'].status,'queued');
});
test('queued change can be cancelled without terminating existing sessions',async t=>{
 const f=fixture(t,{working:true,mode:'tui'});await f.controller.changeModel('baby-worker-1',codex);
 await f.controller.cancelModelChange('baby-worker-1');
 assert.equal(f.controller.state.plans['baby-worker-1'].status,'cancelled');
 assert.equal(f.state.commands.length,0);
});
test('Unknown native outcome is saved for explicit reconciliation; no duplicate submission',async t=>{
 const f=fixture(t);f.native.patchChat=async(id,plan,reserve)=>{reserve();throw Error('Native reply timed out')};
 const r=await f.controller.changeModel('baby-worker-1',codex);
 assert.equal(r.status,'unverified');assert.equal(f.controller.state.plans['baby-worker-1'].status,'unverified');
 await assert.rejects(f.controller.changeModel('baby-worker-1',codex),/needs completion or reconciliation/);
 assert.equal(f.state.commands.length,0);
});
test('legacy staged AGY plan remains inert until explicitly requested by the user',async t=>{
 const f=fixture(t);f.controller.state.plans['baby-worker-1']={harness:'agy',model:'gemini-3.8-flash-high',status:'staged'};
 f.controller.save();
 await f.controller.start();await f.controller.tick();
 assert.equal(f.state.writes.length,0);
 assert.equal(f.controller.state.plans['baby-worker-1'].status,'staged');
});
