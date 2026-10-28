'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AOAdapter, quotaSnapshot } = require('../adapter');
const { configFromEnvironment } = require('../config');
const { createServer, acquireLock } = require('../server');

function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'babytracker-adapter-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
test('configuration fixes project repositories, loopback origin and a distinct state directory', () => {
  const c = configFromEnvironment({}); assert.equal(c.projectId, 'babytracker'); assert.equal(c.runtimeVerified, false); assert.equal(c.port, 4319); assert.match(c.stateDir, /babytracker-fleet/);
  for (const url of ['https://127.0.0.1:3001', 'http://example.org', 'http://user:pass@localhost:3001', 'http://localhost:3001/private']) assert.throws(() => configFromEnvironment({ BABYTRACKER_AO_URL: url }), /loopback/);
  assert.throws(() => configFromEnvironment({ BABYTRACKER_FLEET_PORT: '8787bad' }), /port/);
});
test('native adapter checks live project membership and cannot run global/unknown commands', async t => {
  const commands = [], config = { daemonUrl: 'http://127.0.0.1:3001', aoPath: process.execPath, stateDir: temp(t), runtimeVerified: true };
  const adapter = new AOAdapter(config, { fetcher: async () => ({ ok: true, json: async () => ({ sessions: [{ id: 'mjobs-worker', projectId: 'mjobs-luna' }, { id: 'baby-worker', projectId: 'babytracker' }] }) }), runner: async (...args) => { commands.push(args); } });
  await assert.rejects(adapter.command('kill', 'mjobs-worker'), /BabyTracker/);
  await assert.rejects(adapter.command('kill-all', 'baby-worker'), /Unsupported/);
  await adapter.command('kill', 'baby-worker');
  assert.deepEqual(commands[0][1], ['session', 'kill', 'baby-worker', '--project', 'babytracker']);
  assert.equal(commands[0][2].windowsHide, true); assert.equal(commands[0][2].shell, undefined);
});
test('adapter cannot execute until project/path binding is verified', async t => {
  const adapter = new AOAdapter({ runtimeVerified: false }); await assert.rejects(adapter.command('kill', 'baby-worker'), /binding/);
});
test('quota accepts only fresh, finite, unexpired, non-stopped provider observations', t => {
  const file = path.join(temp(t), 'quota.json'), now = Date.parse('2026-10-27T10:00:00Z');
  const good = { status: 'fresh', heartbeatAt: new Date(now).toISOString(), lastSuccessfulPoll: new Date(now).toISOString(), windows: [{ label: 'weekly', remainingPercent: 72, resetsAt: new Date(now + 3600000).toISOString() }] };
  fs.writeFileSync(file, JSON.stringify(good)); assert.equal(quotaSnapshot(file, now).remainingPercent, 72);
  for (const patch of [{ heartbeatAt: new Date(now + 1).toISOString() }, { lastSuccessfulPoll: new Date(now - 26000).toISOString() }, { windows: [{ remainingPercent: 101 }] }, { windows: [{ remainingPercent: 40, resetsAt: new Date(now - 1).toISOString() }] }, { status: 'emergency_locked' }, { ordinaryUsageAllowed: false }, { error: 'offline' }]) {
    fs.writeFileSync(file, JSON.stringify({ ...good, ...patch })); const result = quotaSnapshot(file, now); assert.equal(result.fresh, false); assert.equal(result.remainingPercent, null);
  }
  assert.equal(quotaSnapshot('', now).remainingPercent, null);
});
test('state lock prevents a second controller and release never removes a new owner', t => {
  const dir = temp(t); const release = acquireLock(dir); assert.throws(() => acquireLock(dir), /already running/);
  const file = path.join(dir, 'controller.lock'); fs.writeFileSync(file, JSON.stringify({ pid: process.pid, nonce: 'different-owner' }));
  release(); assert.equal(fs.existsSync(file), true);
});
test('malformed locks fail closed', t => {
  const dir = temp(t); fs.writeFileSync(path.join(dir, 'controller.lock'), 'broken');
  assert.throws(() => acquireLock(dir), /unreadable/); assert.equal(fs.readFileSync(path.join(dir, 'controller.lock'), 'utf8'), 'broken');
});
test('HTTP controls enforce host, same-origin, token and JSON; GETs do not mutate', async t => {
  const calls = [];
  const controller = { state: { mode: 'paused' }, snapshot: async () => ({ mode: 'paused', sessions: [] }), providers: async () => ({ providers: [] }), pause: () => { calls.push('pause'); return { ok: true }; } };
  const server = createServer({ config: { projectId: 'babytracker' }, controller });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => { server.close(r); server.closeAllConnections(); }));
  const base = 'http://127.0.0.1:' + server.address().port;
  const data = await (await fetch(base + '/api/session')).json();
  assert.equal((await fetch(base + '/api/state')).status, 200); assert.deepEqual(calls, []);
  const post = (headers, body = { action: 'pause' }) => fetch(base + '/api/action', { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await post({ origin: base, 'Content-Type': 'application/json' })).status, 403);
  assert.equal((await post({ origin: 'https://evil.invalid', 'Content-Type': 'application/json', 'X-BabyTracker-Fleet': data.token })).status, 403);
  assert.equal((await post({ origin: base, 'Content-Type': 'text/plain', 'X-BabyTracker-Fleet': data.token })).status, 415);
  const wrongHost = await new Promise((resolve, reject) => { const req = require('node:http').get(base + '/api/state', { headers: { Host: 'evil.invalid' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); });
  assert.equal(wrongHost, 403);
  assert.equal((await post({ origin: base, 'Content-Type': 'application/json', 'X-BabyTracker-Fleet': data.token })).status, 200);
  assert.deepEqual(calls, ['pause']);
  const page = await fetch(base + '/'); assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await page.text(), /BabyTracker/);
  assert.equal((await fetch(base + '/controller.json')).status, 404);
});

test('unified portal GET is read-only and Add Agent action preserves local token/origin protections', async t => {
  const calls = [];
  const controller = {
    state: {mode:'paused'}, snapshot: async () => ({mode:'paused',sessions:[]}),
    providers: async () => ({providers:[{id:'agy',available:true,models:[]}]}),
    addAgent: async a => {calls.push(['add',a]);return {ok:true,note:'created'};},
    reconcileAgentSpawn: async()=>{calls.push(['reconcile']);return {ok:true};},
    dispatch: async(id,kind,opts)=>{calls.push(['dispatch',id,kind,opts]);return {ok:true};}
  };
  const server=createServer({config:{projectId:'babytracker'},controller,projectsReader:async()=>({aoOnline:true,projects:[]})});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const url='http://127.0.0.1:'+server.address().port;
  for(const route of ['/projects','/projects.js','/api/projects','/api/providers']){
    const r=await fetch(url+route);assert.equal(r.status,200);
  }
  assert.equal(calls.length,0);
  const token=(await (await fetch(url+'/api/session')).json()).token;
  const send=(origin,tokenValue,payload)=>fetch(url+'/api/action',{method:'POST',headers:{
    'Origin':origin,'Content-Type':'application/json','X-BabyTracker-Fleet':tokenValue
  },body:JSON.stringify(payload)});
  const newAgent={name:'BabyTracker Gemini Agent',kind:'worker',harness:'agy',model:'gemini-3.8-flash-low',effort:'low',acknowledgeUnknownAgyQuota:true};
  assert.equal((await send('https://external.example',token,{action:'add-agent',agent:newAgent})).status,403);
  assert.equal((await send(url,'bad',{action:'add-agent',agent:newAgent})).status,403);
  assert.equal(calls.length,0);
  assert.equal((await send(url,token,{action:'add-agent',agent:newAgent})).status,200);
  assert.equal((await send(url,token,{action:'find-work',id:'babytracker-4',acknowledgeUnknownAgyQuota:true})).status,200);
  assert.equal((await send(url,token,{action:'reconcile-agent'})).status,200);
  assert.deepEqual(calls.map(x=>x[0]),['add','dispatch','reconcile']);
  assert.deepEqual(calls[1][3],{manualAgy:true});
});

test('Model-change HTTP control requires local-origin token and returns real native status',async t=>{
 const invoked=[];
 const controller={
   state:{mode:'running'},snapshot:async()=>({mode:'running',sessions:[]}),
   providers:async()=>({providers:[]}),
   changeModel:async(id,plan)=>{invoked.push({id,plan});return {ok:true,status:'queued',note:'Current turn continues; queued for idle.'};},
   cancelModelChange:async id=>({ok:true,status:'cancelled',id}),
   reconcileModelChange:async id=>({ok:true,status:'applied',id}),
   resumeModelChange:async id=>({ok:true,status:'queued',id})
 };
 const server=createServer({config:{projectId:'babytracker'},controller});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const origin='http://127.0.0.1:'+server.address().port;
 const token=(await (await fetch(origin+'/api/session')).json()).token;
 const payload={action:'model-change',id:'baby-worker-1',plan:{harness:'agy',model:'gemini-3.8-flash-high',effort:'high',acknowledgeUnknownAgyQuota:true}};
 const post=(csrf,remoteOrigin=origin)=>fetch(origin+'/api/action',{method:'POST',headers:{origin:remoteOrigin,'X-BabyTracker-Fleet':csrf,'Content-Type':'application/json'},body:JSON.stringify(payload)});
 assert.equal((await post('invalid')).status,403);
 assert.equal((await post(token,'https://evil.example')).status,403);
 assert.equal(invoked.length,0);
 const response=await post(token);
 assert.equal(response.status,200);assert.equal((await response.json()).status,'queued');
 assert.deepEqual(invoked,[{id:'baby-worker-1',plan:payload.plan}]);
});
