'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {NativeModelSwitch,NativeFailure}=require('../model-switch');
const {PROJECT}=require('../config');
const origin='http://127.0.0.1:3001';
function fixture() {
 let session={id:'baby-worker-1',projectId:PROJECT,harness:'codex',model:'gpt-6-luna',mode:'chat',activity:{state:'active'},createdAt:'2026-10-27T10:00:00Z',isTerminated:false};
 let settings={approvalMode:'auto',model:'gpt-6-luna',reasoningEffort:'medium',fastMode:false};
 let phase=null, posts=[], conversation={sessionId:session.id,harness:'codex'};
 const handler=async(url,opts)=>{
  const route=url.slice(origin.length), method=opts.method;
  if(method==='GET'&&route==='/api/v1/sessions/'+session.id)return ok({session});
  if(method==='GET'&&route.endsWith('/conversation/models'))return ok({models:[
   {id:'gpt-6-luna',efforts:['low','medium','high']},{id:'gpt-6-sol',efforts:['medium','high']}],selected:settings});
  if(method==='GET'&&route.endsWith('/conversation'))return ok({...conversation,settings});
  if(method==='PATCH'&&route.endsWith('/conversation/settings')){
   const body=JSON.parse(opts.body);posts.push({method,body});
   if(body.approvalMode!=='auto')return error(400,'APPROVAL_DOWNGRADE');
   settings=body;return ok(settings);
  }
  if(method==='GET'&&route.endsWith('/interface-transition'))return ok({supported:true,targetMode:session.mode==='chat'?'tui':'chat',transition:phase});
  if(method==='POST'&&route.endsWith('/interface-transition')){
   const b=JSON.parse(opts.body); posts.push({method,body:b});
   phase={id:'transition-1',phase:'draining',targetMode:b.targetMode};return ok({transition:phase});
  }
  if(method==='POST'&&route.endsWith('/provider-switch')){
   const b=JSON.parse(opts.body);posts.push({method,body:b});
   if(session.activity.state==='active')return error(409,'PROVIDER_SWITCH_busy');
   session={...session,harness:b.targetHarness,model:b.model,mode:'tui'};return ok({status:'ok'});
  }
  return error(404,'NOT_FOUND');
 };
 const ok=val=>({ok:true,status:200,json:async()=>structuredClone(val)});
 const error=(status,code)=>({ok:false,status,json:async()=>({error:{code,message:code}})});
 const native=new NativeModelSwitch({runtimeVerified:true,daemonUrl:origin},{fetcher:handler});
 return {native,posts,get session(){return session;},setSession:s=>{session={...session,...s}},get settings(){return settings;},
   finishTransition:targetMode=>{session.mode=targetMode;phase={...phase,phase:'completed'}}};
}
test('Codex Chat busy turn accepts native next-turn model settings and preserves permissions',async()=>{
 const f=fixture(),selection={harness:'codex',model:'gpt-6-sol',effort:'high'};
 let reservations=0;
 const result=await f.native.patchChat('baby-worker-1',selection,()=>reservations++);
 assert.equal(result.status,'applied_next_turn');
 assert.equal(reservations,1);
 assert.equal(f.posts.length,1);
 assert.deepEqual(f.posts[0].body,{approvalMode:'auto',model:'gpt-6-sol',reasoningEffort:'high',fastMode:false});
 assert.equal(f.session.activity.state,'active');
 assert.equal(f.session.harness,'codex');
 assert.equal(f.settings.model,'gpt-6-sol');
});
test('Native model catalog rejects unknown model before any mutation',async()=>{
 const f=fixture();await assert.rejects(f.native.patchChat('baby-worker-1',{harness:'codex',model:'unlisted',effort:'high'},()=>{throw Error('MUST_NOT_SUBMIT')}),/not offered/);
 assert.equal(f.posts.length,0);
});
test('AO same-project terminal switch preserves session ID with explicit provider/model',async()=>{
 const f=fixture();f.setSession({mode:'tui',activity:{state:'idle'}});let reservations=0;
 const result=await f.native.switchProvider('baby-worker-1',{harness:'agy',model:'gemini-3.8-flash-high',effort:'high',effortMode:'model-id'},'request-1',()=>reservations++);
 assert.equal(result.status,'applied');assert.equal(reservations,1);
 assert.equal(f.posts.length,1);assert.deepEqual(f.posts[0].body,{targetHarness:'agy',model:'gemini-3.8-flash-high',idempotencyKey:'request-1'});
 assert.equal(f.session.id,'baby-worker-1');assert.equal(f.session.projectId,PROJECT);
});
test('AO refuses provider switch during active turn without touching original session',async()=>{
 const f=fixture();f.setSession({mode:'tui',activity:{state:'active'}});let reserved=false;
 await assert.rejects(f.native.switchProvider('baby-worker-1',{harness:'agy',model:'gemini-3.8-flash-high',effortMode:'model-id'},'req-2',()=>{reserved=true}),/not idle/);
 assert.equal(reserved,false);assert.equal(f.session.harness,'codex');assert.equal(f.posts.length,0);
});
test('Durable AO interface transition uses drain policy, never interrupt',async()=>{
 const f=fixture();let reserved=false;
 const result=await f.native.startTransition('baby-worker-1','tui',()=>{reserved=true});
 assert.equal(result.id,'transition-1');assert.equal(reserved,true);
 assert.deepEqual(f.posts[0].body,{targetMode:'tui',policy:'drain',historyPolicy:'strict'});
 f.finishTransition('tui');assert.equal((await f.native.transition('baby-worker-1')).transition.phase,'completed');
});
test('AO session membership mismatch is rejected before any action',async()=>{
 const f=fixture();f.setSession({projectId:'mjobs-luna'});
 await assert.rejects(f.native.patchChat('baby-worker-1',{harness:'codex',model:'gpt-6-sol',effort:'high'},()=>{throw Error('MUST_NOT_SUBMIT')}),/BabyTracker/);
 assert.equal(f.posts.length,0);
});
test('AO unreadable or transport outcomes stay unverified, never automatically replayed',async()=>{
 const native=new NativeModelSwitch({runtimeVerified:true,daemonUrl:origin},{fetcher:async()=>{throw Error('disconnected')}});
 await assert.rejects(native.session('baby-worker-1'),e=>e instanceof NativeFailure && !e.definite);
});
