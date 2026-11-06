'use strict';
// All provider, AO, resource and quota reads are inert fixtures.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { IssueQueue } = require('./issue-queue');
const { RosterControl } = require('./roster-control');
const { ProductiveFleet } = require('./productive-fleet');
const now = Date.parse('2026-11-06T00:00:00Z');
const issue = number => ({number, title:'Implement bounded issue '+number, state:'OPEN', assignees:[], labels:[]});
const worker = (id, extra={}) => ({id,projectId:'mjobs',kind:'worker',name:id,model:'gpt-6-luna',effort:'medium',mode:'chat',harness:'codex',activity:'idle',isIdle:true,busy:false,openPRs:0,prs:[],...extra});
function fixture(t) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'productive-fleet-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const queue=new IssueQueue(root), roster=new RosterControl(root), commands=[];
 const snapshot={projectId:'mjobs',sessions:[worker('mjobs-1',{kind:'orchestrator',model:'gpt-6-astra',effort:'high',busy:true,isIdle:false,activity:'working'})],summary:{working:1}};
 const gh={fresh:true,open:[],issues:[issue(101),issue(102),issue(103)],at:new Date(now).toISOString()};
 const quota={fresh:true,remainingPercent:50,blocked:false};
 const resources={freeRamGiB:20,freeDiskGiB:100,cpuPercent:10};
 const deps={queue,roster,getState:async()=>snapshot,github:async()=>gh,resources:async()=>resources,quota:()=>quota,guard:()=>null,eligible:s=>s.isIdle&&!s.busy&&!s.frozen,clock:()=>now,
  command:async args=>{commands.push(args);if(args[0]==='spawn')snapshot.sessions.push(worker('mjobs-'+(commands.length+1),{name:args[args.indexOf('--name')+1],model:args[args.indexOf('--model')+1],effort:args[args.indexOf('--effort')+1]}));}};
 const fleet=new ProductiveFleet(deps);
 return {root,queue,roster,commands,snapshot,gh,quota,resources,deps,fleet,run:options=>fleet.reconcile({rootId:'mjobs-1',budget:6,targetWorking:40,...options})};
}
test('durable default is 1 xhigh Astra plus 14 Astra Medium / 25 Luna Medium workers; settings persist',t=>{
 const f=fixture(t), p=f.roster.read();
 assert.deepEqual(p.workerGroups.map(g=>[g.model,g.desired,g.effort]),[['gpt-6-astra',14,'medium'],['gpt-6-sol',0,'medium'],['gpt-6-luna',25,'medium']]);
 assert.equal(p.orchestrator.effort,'xhigh');assert.equal(p.dispatch.targetWorking,25);
 f.roster.update({astra:2,sol:3,luna:4,targetWorking:10});
 assert.equal(new RosterControl(f.root).read().safety.maxTotalSessions,10);
 for(const v of [{astra:40},{sol:-1},{luna:1.5},{targetWorking:41},{model:'gpt-other'}])assert.throws(()=>f.roster.update(v));
});
test('corrupt profile and ledger fail closed and preserve bytes',t=>{
 const f=fixture(t);for(const [file,read] of [[f.roster.file,()=>f.roster.read()],[f.queue.file,()=>f.queue.load()]]){
 fs.writeFileSync(file,'{"bad":true}');assert.throws(read);assert.equal(fs.readFileSync(file,'utf8'),'{"bad":true}');}
});
test('legacy IDs, one issue per worker, one worker per issue, persistent no-replay',t=>{
 const f=fixture(t);assert.equal(f.queue.reserve(101,'mjobs-luna-7',now),true);
 assert.equal(f.queue.reserve(101,'mjobs-8',now),false);assert.equal(f.queue.reserve(102,'mjobs-luna-7',now),false);
 f.queue.mark(101,'uncertain');assert.equal(new IssueQueue(f.root).reserve(101,'mjobs-9',now),false);
});
test('only explicitly unassigned OPEN issues without existing PR or session ownership qualify',t=>{
 const f=fixture(t);f.gh.issues.push({...issue(104),assignees:[{login:'owner'}]},{...issue(105),state:'CLOSED'},{number:106,title:'unknown assignees',state:'OPEN'},{...issue(107),labels:[{name:'in-progress'}]},issue(101));
 f.gh.open=[{body:'Fixes #101',closingIssuesReferences:[{number:102}]}];
 f.snapshot.sessions.push(worker('mjobs-8',{issueNumber:103}));
 assert.deepEqual(f.queue.candidates(f.gh.issues,f.snapshot.sessions,f.gh.open),[]);
});
test('idle workers get distinct durable issue instructions once, before spawning',async t=>{
 const f=fixture(t);f.snapshot.sessions.push(worker('mjobs-luna-7'),worker('mjobs-8'));
 const result=await f.run({budget:2});assert.equal(result.attempted,2);
 assert.deepEqual(f.commands.map(a=>a[0]),['send','send']);
 assert.match(f.commands[0][4],/ISSUE #101/);assert.match(f.commands[1][4],/ISSUE #102/);
 assert.match(f.commands[0][4],/Do not edit.*exclusive file scope/i);
 f.gh.issues=[issue(101),issue(102)];await f.run();assert.equal(f.commands.length,2);
});
test('spawn reservations precede native calls; exact identity is bound, maximum two per cycle',async t=>{
 const f=fixture(t), original=f.deps.command;f.fleet.command=async args=>{assert.ok(Object.values(f.queue.load().claims).some(c=>c.status==='reserved'&&c.kind==='spawn'));await original(args);};
 const r=await f.run();assert.equal(r.attempted,2);assert.equal(f.commands.length,2);
 assert.ok(f.commands.every(a=>a.includes('gpt-6-astra')&&a.includes('medium')&&a.includes('--prompt')));
 assert.deepEqual(Object.values(f.queue.load().claims).map(c=>c.agentId),['mjobs-2','mjobs-3']);
 assert.ok(Object.values(f.queue.load().claims).every(c=>c.status==='submitted'));
});
test('provider timeout preserves uncertain claim and prevents further spawning after restart',async t=>{
 const f=fixture(t);f.deps.command=f.fleet.command=async args=>{f.commands.push(args);throw Error('response lost');};
 await f.run();assert.equal(f.commands.length,1);assert.equal(f.queue.load().claims[101].status,'uncertain');
 await new ProductiveFleet(f.deps).reconcile({rootId:'mjobs-1',budget:6,targetWorking:40});assert.equal(f.commands.length,1);
});
test('spawn success without exact identity remains uncertain; unknown sessions count toward capacity',async t=>{
 const f=fixture(t);f.fleet.command=async args=>f.commands.push(args);
 await f.run();assert.equal(f.commands.length,1);assert.equal(f.queue.load().claims[101].status,'uncertain');
});
for(const [name,change] of [
 ['stale quota',f=>f.quota.fresh=false],['quota at reserve',f=>f.quota.remainingPercent=1],['provider denied',f=>f.quota.blocked=true],
 ['CPU pressure',f=>f.resources.cpuPercent=86],['RAM pressure',f=>f.resources.freeRamGiB=11.9],['disk pressure',f=>f.resources.freeDiskGiB=79.9],
 ['missing CPU',f=>f.resources.cpuPercent=null],['missing disk',f=>f.resources.freeDiskGiB=null],['offline AO',f=>f.snapshot.offline=true],
 ['no issues',f=>f.gh.issues=[]],['missing issue API',f=>delete f.gh.issues],['stale GitHub',f=>f.gh.fresh=false],
 ['ambiguous primary',f=>f.snapshot.sessions.push({...f.snapshot.sessions[0],id:'mjobs-9'})],['manual hold',f=>f.fleet.guard=()=> 'paused']
])test(name+' blocks automatic work',async t=>{const f=fixture(t);change(f);await f.run();assert.equal(f.commands.length,0);});
test('provider read failure never falls back to cached issues',async t=>{const f=fixture(t);f.fleet.github=async()=>{throw Error('offline');};await f.run();assert.equal(f.commands.length,0);});
test('capacity includes replaced and unknown model sessions; lower target never kills sessions',async t=>{
 const f=fixture(t);f.roster.update({astra:0,sol:0,luna:1,targetWorking:2});
 f.snapshot.sessions.push(worker('mjobs-9',{model:'unknown',replacedBy:'mjobs-10',isIdle:false}));
 await f.run();assert.equal(f.commands.length,0);assert.equal(f.snapshot.sessions.length,2);
});
test('pending submissions consume working capacity even when AO still reports idle',async t=>{
 const f=fixture(t);f.snapshot.sessions.push(worker('mjobs-7'),worker('mjobs-8'));
 await f.run({targetWorking:2});await f.run({targetWorking:2});assert.equal(f.commands.length,1);
});
test('pause or claim appearing during asynchronous preflight prevents submission',async t=>{
 const f=fixture(t);f.fleet.resources=async()=>{f.fleet.guard=()=> 'paused';return f.resources;};
 await f.run();assert.equal(f.commands.length,0);assert.deepEqual(f.queue.load().claims,{});
});
test('worker becoming busy during resource preflight receives no competing instruction',async t=>{
 const f=fixture(t);f.snapshot.sessions.push(worker('mjobs-7'));
 f.fleet.resources=async()=>{f.snapshot.sessions[1]={...f.snapshot.sessions[1],busy:true,isIdle:false,activity:'working'};return f.resources;};
 await f.run({budget:1});assert.equal(f.commands.length,0);
});
test('two reconcilers cannot reserve capacity concurrently',async t=>{
 const f=fixture(t);let release;const original=f.fleet.resources;
 f.fleet.resources=async s=>{await new Promise(resolve=>release=resolve);return original(s);};
 const first=f.run({budget:1});while(!release)await new Promise(resolve=>setImmediate(resolve));
 const other=await new ProductiveFleet(f.deps).reconcile({rootId:'mjobs-1',budget:1,targetWorking:40});
 assert.equal(other.attempted,0);release();await first;assert.equal(f.commands.length,1);
});
test('lock contention fails closed without deleting another owner lock',async t=>{
 const f=fixture(t);fs.writeFileSync(f.queue.file+'.lock','owner');await f.run();assert.equal(f.commands.length,0);
 assert.equal(fs.readFileSync(f.queue.file+'.lock','utf8'),'owner');
});
test('Turbo uses productive reconciliation for issue snapshots, without filler; previews are inert',async t=>{
 const f=fixture(t),{Turbo}=require('./turbo');
 const turbo=new Turbo({root:f.root,autoSchedule:false,clock:()=>now,audit:()=>{},getState:f.deps.getState,command:f.deps.command,githubRunner:f.deps.github,quotaStatus:()=>f.quota});
 turbo.signals=async()=>f.resources;
 const preview=await turbo.preview();assert.equal(f.commands.length,0);
 assert.equal(preview.preview.nextActions.length,0);
 turbo.enable(true);const r=await turbo.cycle();
 assert.equal(f.commands.length,2);assert.equal(r.productive.attempted,2);assert.equal(turbo.summary().sentThisHour,2);
 assert.equal(turbo.summary().roster.profile.dispatch.targetWorking,25);
 f.gh.issues=[];await turbo.cycle();assert.equal(f.commands.length,2,'no issue means no filler');
});
