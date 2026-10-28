'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { validateAgentInput, provisionAgent } = require('../agent-provision');
const CATALOG = { providers: [
  {id:'codex',available:true,models:[{id:'gpt-6-luna',name:'Luna',efforts:['low','medium','high'],defaultEffort:'medium',effortMode:'flag'}]},
  {id:'agy',available:true,models:[{id:'gemini-3.8-flash-high',name:'Gemini High',efforts:['high'],defaultEffort:'high',effortMode:'model-id'}]},
  {id:'gemini',available:false,models:[]}
]};
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bt-agent-provision-test-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const config={runtimeVerified:true,aoPath:process.execPath,repoPath:dir};
  const state={submits:0,spawned:[],authorized:true,repo:'https://github.com/MulattoTech/BabyTracker.git',sessions:[{
    id:'mjobs-1',projectId:'mjobs-luna',kind:'worker',harness:'codex',displayName:'MJobs Worker',activity:{state:'active'},isTerminated:false}]};
  const deps = {runner:async(exe,args,opts)=>{
    assert.equal(exe, process.execPath);assert.equal(opts.windowsHide,true);assert.equal(opts.cwd,dir);assert.equal(opts.shell,undefined);
    if(args[0]==='project')return {stdout:JSON.stringify({project:{id:'babytracker',kind:'single_repo',path:dir,repo:state.repo}})};
    if(args[0]==='agent')return {stdout:JSON.stringify({supported:[
      {id:'agy',authStatus:state.authorized?'authorized':'unauthorized'},
      {id:'codex',authStatus:'authorized'}]})};
    assert.equal(args[0],'spawn');
    assert.equal(state.submits,1);
    state.spawned.push(args);
    if(state.fail)throw Error('Simulated AGY network timeout');
    const id='babytracker-'+(state.sessions.length+1);
    state.sessions.push({id,projectId:'babytracker',kind:args[args.indexOf('--kind')+1],
      harness:args[args.indexOf('--harness')+1],displayName:args[args.indexOf('--name')+1],
      activity:{state:'idle'},isTerminated:false});
    return {stdout:'created'};
  },sessions:async()=>structuredClone(state.sessions),onSubmit:()=>{state.submits++;},sleep:async()=>{}};
  return {state,deps,config};
}
test('AGY Gemini model selection encodes effort in model ID; CLI receives no unsupported effort flag', async t=>{
  const f=fixture(t);
  const selection=validateAgentInput({name:'BabyTracker Gemini 1',kind:'worker',harness:'agy',model:'gemini-3.8-flash-high',effort:'high'},CATALOG);
  const result=await provisionAgent(f.config,{...f.deps,selection});
  assert.equal(result.harness,'agy');
  assert.equal(selection.mode,'tui');
  assert.equal(result.created,true);
  assert.deepEqual(f.state.spawned[0],['spawn','--project','babytracker','--kind','worker','--harness','agy','--mode','tui','--name','BabyTracker Gemini 1','--model','gemini-3.8-flash-high']);
  assert.equal(f.state.sessions[0].projectId,'mjobs-luna');
});
test('Codex reasoning passes explicit effort flag for brand-new agent',async t=>{
  const f=fixture(t);
  const selection=validateAgentInput({name:'BabyTracker Reviewer',kind:'worker',harness:'codex',model:'gpt-6-luna',effort:'high'},CATALOG);
  await provisionAgent(f.config,{...f.deps,selection});
  assert.equal(selection.mode,'chat');
  assert.deepEqual(f.state.spawned[0].slice(-2),['--effort','high']);
});
test('unknown providers, models, and unsafe names are refused at selection',()=>{
  for(const patch of [{harness:'gemini'},{model:'made-up'},{name:'../../shadow'},{kind:'admin'},{effort:'xhigh'}]){
    assert.throws(()=>validateAgentInput({name:'BabyTracker Gemini 1',kind:'worker',harness:'agy',model:'gemini-3.8-flash-high',effort:'high',...patch},CATALOG));
  }
});
test('unauthorized AGY and changed project remote fail before submitting spawn',async t=>{
  const f=fixture(t);
  const selection=validateAgentInput({name:'BabyTracker Gemini 1',kind:'worker',harness:'agy',model:'gemini-3.8-flash-high',effort:'high'},CATALOG);
  f.state.authorized=false;
  await assert.rejects(provisionAgent(f.config,{...f.deps,selection}),/authorized/);
  f.state.authorized=true; f.state.repo='https://github.com/MulattoTech/MJobs.git';
  await assert.rejects(provisionAgent(f.config,{...f.deps,selection}),/repository/);
  assert.equal(f.state.submits,0);
});
test('duplicate live names cannot be spawned and uncertain submission is never automatically retried',async t=>{
  const f=fixture(t);
  const selection=validateAgentInput({name:'MJobs Worker',kind:'worker',harness:'agy',model:'gemini-3.8-flash-high',effort:'high'},CATALOG);
  // Another project may use the same display name; it cannot affect BabyTracker.
  const ok=await provisionAgent(f.config,{...f.deps,selection});
  assert.ok(ok.created);
  await assert.rejects(provisionAgent(f.config,{...f.deps,selection}),/already uses/);
  assert.equal(f.state.spawned.length,1);
  const g=fixture(t);g.state.fail=true;
  await assert.rejects(provisionAgent(g.config,{...g.deps,selection}),/AO rejected agy spawn/);
  assert.equal(g.state.submits,1);
  assert.equal(g.state.spawned.length,1);
});
