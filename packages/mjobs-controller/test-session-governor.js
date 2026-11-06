'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {SessionGovernor}=require('./session-governor');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-scope-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const base=Date.parse('2026-10-29T13:00:00Z');
 const sessions=[
 {id:'mjobs-luna-113',projectId:'mjobs-luna',kind:'orchestrator',createdAt:new Date(base-100000).toISOString(),isTerminated:false,activity:{state:'idle'}},
 {id:'mjobs-luna-70',projectId:'mjobs-luna',kind:'worker',createdAt:new Date(base-100000).toISOString(),isTerminated:false,activity:{state:'idle'}},
 {id:'babytracker-1',projectId:'babytracker',kind:'orchestrator',createdAt:new Date(base-100000).toISOString(),isTerminated:false,activity:{state:'active'}},
 {id:'mjobs-luna-41',projectId:'mjobs-luna',kind:'orchestrator',createdAt:new Date(base-200000).toISOString(),isTerminated:true,activity:{state:'exited'}}];
 const state={time:base,stops:[],paused:0,events:[],sessions,policy:{version:1,projectId:'mjobs-luna',primaryId:'mjobs-luna-113',maxSessions:2,sessionIds:['mjobs-luna-113','mjobs-luna-70'],enforceLiveRoster:true}};
 const save=()=>fs.writeFileSync(path.join(root,'startup-selection.json'),JSON.stringify(state.policy));
 save();
 const guard=new SessionGovernor({root,now:()=>state.time, listSessions:async()=>structuredClone(sessions),getSession:async id=>structuredClone(sessions.find(s=>s.id===id)),
  exitAgent:async id=>{const s=sessions.find(s=>s.id===id);if(!s)throw Error('unknown');state.stops.push(id);s.activity.state='exited';return {ok:true}},
  pauseDispatch:()=>{state.paused++},audit:(event,fields)=>state.events.push({event,...fields})});
 const spawn=id=>{const s={id,projectId:'mjobs-luna',kind:'worker',createdAt:new Date(state.time).toISOString(),isTerminated:false,activity:{state:'active'}};sessions.push(s);return s};
 return {guard,state,save,spawn};
}
test('approved roster remains online, other projects and archived sessions untouched',async t=>{
 const f=fixture(t),result=await f.guard.check();assert.equal(result.enabled,true);assert.equal(result.verifiedExits,0);assert.deepEqual(f.state.stops,[]);assert.equal(f.state.sessions[2].activity.state,'active');assert.equal(f.state.paused,0);
});
test('unapproved native worker is gracefully exited once and its session preserved',async t=>{
 const f=fixture(t);f.spawn('mjobs-luna-114');const r=await f.guard.check();
 assert.equal(r.verifiedExits,1);assert.deepEqual(f.state.stops,['mjobs-luna-114']);assert.equal(f.state.sessions.at(-1).isTerminated,false);assert.equal(f.state.sessions.at(-1).activity.state,'exited');
 await f.guard.check();assert.deepEqual(f.state.stops,['mjobs-luna-114']);
});
test('second distinct unapproved spawn pauses dispatch and parks only the selected primary',async t=>{
 const f=fixture(t);f.spawn('mjobs-luna-114');await f.guard.check();f.state.time+=6000;f.spawn('mjobs-luna-115');const result=await f.guard.check();
 assert.equal(result.paused,true);assert.deepEqual(f.state.stops,['mjobs-luna-114','mjobs-luna-115','mjobs-luna-113']);assert.equal(f.state.paused,1);
 assert.equal(f.state.sessions.find(s=>s.id==='mjobs-luna-70').activity.state,'idle');
 assert.equal(f.state.sessions.find(s=>s.projectId==='babytracker').activity.state,'active');
});
test('invalid policy or foreign identity cannot authorize a native stop',async t=>{
 const f=fixture(t);f.spawn('mjobs-luna-114');f.state.policy.maxSessions=1;f.save();const result=await f.guard.check();
 assert.match(result.error,/policy/);assert.deepEqual(f.state.stops,[]);
});
test('identity changing after inventory does not permit a stop',async t=>{
 const f=fixture(t);f.spawn('mjobs-luna-114');f.guard.getSession=async id=>({...f.state.sessions.find(s=>s.id===id),createdAt:'replaced-session'});
 const result=await f.guard.check();assert.equal(result.verifiedExits,0);assert.deepEqual(f.state.stops,[]);
});
