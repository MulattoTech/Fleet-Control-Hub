'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FleetController } = require('../controller');
const { PROJECT, SOURCE_REPO, ISSUE_REPO } = require('../config');

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function session(id, extra = {}) { return { id, projectId: PROJECT, kind: 'worker', harness: 'codex', activity: { state: 'idle' }, isTerminated: false, ...extra }; }
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'babytracker-fleet-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let time = Date.parse('2026-10-27T10:00:00Z');
  const config = { projectId: PROJECT, sourceRepository: SOURCE_REPO, issueRepository: ISSUE_REPO, stateDir: dir, runtimeVerified: true };
  const state = { sessions: [session('baby-worker-1'), session('baby-worker-2'), session('mjobs-worker-1', { projectId: 'mjobs-luna' })], commands: [], provisions: 0, quota: { fresh: true, remainingPercent: 80 }, fail: false, ...options };
  const adapter = {
    sessions: async () => structuredClone(state.sessions),
    provisionCodex: async (beforeSubmit = () => {}) => {
      if (!state.bootstrap) throw Error('No verified BabyTracker Codex session exists and bootstrap is unavailable');
      beforeSubmit(); state.provisions++;
      if (state.bootstrap === 'uncertain') throw Error('Simulated AO provisioning transport loss');
      state.sessions.push(session('baby-bootstrap-1', { kind: 'orchestrator', displayName: 'BabyTracker Orchestrator' }));
      return { id: 'baby-bootstrap-1', created: true };
    },
    command: async (action, id, message, before = () => {}) => {
      const s = state.sessions.find(s => s.id === id); before(s);
      state.commands.push({ action, id, message });
      if (state.fail) throw Error('Simulated transport interruption');
      if (['kill', 'exit'].includes(action)) s.isTerminated = true;
      return { submitted: true };
    }
  };
  const deps = { adapter, quota: () => state.quota, now: () => time, resources: () => ({ freeMemoryGiB: 12, totalMemoryGiB: 32, cpuPercent: null, diskIO: null }) };
  const controller = new FleetController(config, deps);
  return { controller, state, config, deps, adapter, dir, advance: ms => { time += ms; } };
}

test('uncertain bootstrap reconciles only after two unchanged project reads and audit delay', async t => {
  const f = fixture(t, { sessions: [session('mjobs-worker', { projectId: 'mjobs-luna' })], bootstrap: 'uncertain' });
  await assert.rejects(f.controller.start(), /unverified/);
  assert.equal(f.controller.state.bootstrap.status, 'uncertain');
  await assert.rejects(f.controller.reconcileBootstrap('wrong'), /confirmation/);
  await assert.rejects(f.controller.reconcileBootstrap('RECONCILE BOOTSTRAP'), /timing/);
  f.advance(31_000);
  const result = await f.controller.reconcileBootstrap('RECONCILE BOOTSTRAP');
  assert.equal(result.ok, true);
  assert.equal(f.controller.state.bootstrap.status, 'reconciled_no_new_session');
  assert.equal(f.controller.state.mode, 'paused');
  assert.equal(f.state.provisions, 1);
});
test('uncertain bootstrap cannot clear when a new project session appears', async t => {
  const f = fixture(t, { sessions: [session('mjobs-worker', { projectId: 'mjobs-luna' })], bootstrap: 'uncertain' });
  await assert.rejects(f.controller.start(), /unverified/);
  f.advance(31_000);
  f.state.sessions.push(session('baby-new', { createdAt: new Date(Date.parse('2026-10-27T10:00:01Z')).toISOString(), activity: { state: 'exited' } }));
  await assert.rejects(f.controller.reconcileBootstrap('RECONCILE BOOTSTRAP'), /appeared/);
  assert.equal(f.controller.state.bootstrap.status, 'uncertain');
});
test('startup and every dashboard read spend no inference and exclude MJobs', async t => {
  const f = fixture(t); const snap = await f.controller.snapshot();
  assert.equal(snap.mode, 'paused'); assert.equal(snap.sessions.length, 2);
  assert.ok(snap.sessions.every(s => s.projectId === PROJECT));
  assert.equal(snap.acceptance.percent, null); assert.equal(snap.sessions[0].tokens, null);
  assert.equal(f.state.commands.length, 0);
});
test('cross-project dispatch is rejected even when the daemon returns that session', async t => {
  const f = fixture(t); await f.controller.start();
  await assert.rejects(f.controller.dispatch('mjobs-worker-1'), /BabyTracker/);
  assert.equal(f.state.commands.length, 0);
});
test('runtime binding must be explicitly verified before enabling dispatch', async t => {
  const f = fixture(t); f.config.runtimeVerified = false;
  await assert.rejects(f.controller.start(), /binding/); assert.equal(f.state.commands.length, 0);
});
test('unavailable and insufficient quota fail closed without fabricated remaining values', async t => {
  const f = fixture(t); f.state.quota = { fresh: false, remainingPercent: null, reason: 'unavailable' };
  await assert.rejects(f.controller.start(), /unavailable/);
  f.state.quota = { fresh: true, remainingPercent: 20 };
  await assert.rejects(f.controller.start(), /threshold/); assert.equal(f.state.commands.length, 0);
});
test('Start changes only local run state; it does not launch or assign a worker', async t => {
  const f = fixture(t); await f.controller.start();
  assert.equal(f.controller.state.mode, 'running'); assert.equal(f.controller.state.run.dispatches, 0);
  assert.equal(f.state.commands.length, 0);
  await assert.rejects(f.controller.start(), /Pause/);
});
test('no project session without available bootstrap remains paused, with no native mutation', async t => {
  const f = fixture(t, { sessions: [session('mjobs-worker', { projectId: 'mjobs-luna' })] });
  await assert.rejects(f.controller.start(), /No verified/);
  assert.equal(f.controller.state.mode, 'paused');
  assert.equal(f.state.provisions, 0);
  assert.equal(f.state.commands.length, 0);
});
test('explicit Start provisions one BabyTracker orchestrator, never auto-sends work or touches MJobs', async t => {
  const f = fixture(t, { sessions: [session('mjobs-worker', { projectId: 'mjobs-luna' })], bootstrap: 'success' });
  const baseline = structuredClone(f.state.sessions[0]);
  const result = await f.controller.start();
  assert.match(result.note, /was created/);
  assert.equal(f.state.provisions, 1);
  assert.equal(f.controller.state.mode, 'running');
  assert.equal(f.controller.state.run.dispatches, 0);
  assert.equal(f.controller.state.bootstrap.status, 'verified');
  assert.equal(f.state.commands.length, 0);
  assert.deepEqual(f.state.sessions[0], baseline);
  f.controller.pause();
  await f.controller.start();
  assert.equal(f.state.provisions, 1);
});
test('stale quota stops bootstrap before CLI; a failing submission persists an uncertain latch', async t => {
  const f = fixture(t, { sessions: [], bootstrap: 'uncertain' });
  f.state.quota = { fresh: false, remainingPercent: null, reason: 'stale' };
  await assert.rejects(f.controller.start(), /stale/);
  assert.equal(f.state.provisions, 0);
  f.state.quota = { fresh: true, remainingPercent: 50 };
  await assert.rejects(f.controller.start(), /unverified/);
  assert.equal(f.state.provisions, 1);
  assert.equal(f.controller.state.bootstrap.status, 'uncertain');
  await assert.rejects(f.controller.start(), /unverified delivery/);
  const restarted = new FleetController(f.config, f.deps);
  await assert.rejects(restarted.start(), /unverified delivery/);
  assert.equal(f.state.provisions, 1);
});
test('emergency during new session provisioning fences dispatch and targets only its newly created session', async t => {
  const f = fixture(t, { sessions: [session('mjobs-worker', { projectId: 'mjobs-luna' })], bootstrap: 'success' });
  const previous = f.adapter.provisionCodex;
  f.adapter.provisionCodex = async beforeSubmit => {
    const result = await previous(beforeSubmit);
    await f.controller.stop(true);
    return result;
  };
  await assert.rejects(f.controller.start(), /superseded/);
  assert.equal(f.controller.state.mode, 'emergency');
  assert.ok(f.state.sessions[1].isTerminated);
  assert.equal(f.state.sessions[0].isTerminated, false);
  assert.equal(f.state.commands.length, 1);
  assert.equal(f.state.commands[0].id, 'baby-bootstrap-1');
});
test('explicit new Start works after the prior bounded run exhausted dispatches and deadline', async t => {
  const f = fixture(t); f.controller.limits({ maxDispatches: 1, maxMinutes: 1 }); await f.controller.start();
  await f.controller.dispatch('baby-worker-1'); f.advance(120001); f.controller.pause();
  await f.controller.start(); assert.equal(f.controller.state.run.dispatches, 0);
  assert.equal(f.controller.state.mode, 'running');
});
test('last budget unit dispatches once, then further work is blocked', async t => {
  const f = fixture(t); f.controller.limits({ maxDispatches: 1 }); await f.controller.start();
  await f.controller.dispatch('baby-worker-1');
  await assert.rejects(f.controller.dispatch('baby-worker-2'), /budget/); assert.equal(f.state.commands.length, 1);
  await f.controller.tick(); assert.equal(f.controller.state.mode, 'paused');
});
test('pending submission counts toward concurrency while daemon still reports idle', async t => {
  const f = fixture(t); f.controller.limits({ concurrency: 1 }); await f.controller.start();
  await f.controller.dispatch('baby-worker-1');
  await assert.rejects(f.controller.dispatch('baby-worker-2'), /Concurrency/); assert.equal(f.state.commands.length, 1);
});
test('All Hands respects existing busy work and newly submitted turns', async t => {
  const f = fixture(t); f.state.sessions.push(session('baby-worker-3'));
  f.state.sessions[0].activity.state = 'working'; f.controller.limits({ concurrency: 2 });
  await f.controller.start(); const result = await f.controller.allHands();
  assert.equal(result.results.filter(r => r.ok).length, 1); assert.equal(f.state.commands.length, 1);
  assert.notEqual(f.state.commands[0].id, 'mjobs-worker-1');
});
test('a pause fences a dispatch awaiting live runtime state', async t => {
  const f = fixture(t); await f.controller.start(); const gate = deferred();
  f.adapter.sessions = () => gate.promise;
  const pending = f.controller.dispatch('baby-worker-1'); f.controller.pause(); gate.resolve(f.state.sessions);
  await assert.rejects(pending, /paused|superseded/); assert.equal(f.state.commands.length, 0);
});
test('a changed runtime identity/activity before native send fences the action', async t => {
  const f = fixture(t); await f.controller.start();
  f.adapter.command = async (action, id, message, before) => before(session(id, { activity: { state: 'working' } }));
  await assert.rejects(f.controller.dispatch('baby-worker-1'), /changed/);
  assert.equal(f.controller.ledger.entries['baby-worker-1'].status, 'uncertain');
});
test('uncertain delivery survives cooldown, restart and old-entry pruning without automatic retry', async t => {
  const f = fixture(t); await f.controller.start(); f.state.fail = true;
  await assert.rejects(f.controller.dispatch('baby-worker-1'), /unverified/);
  f.advance(2 * 86400000); f.controller.ledger.save();
  const restarted = new FleetController(f.config, f.deps);
  assert.equal(restarted.state.mode, 'paused');
  await assert.rejects(restarted.start(), /Unresolved delivery/);
  assert.equal(restarted.ledger.entries['baby-worker-1'].status, 'uncertain');
  assert.equal(f.state.commands.length, 1);
});
test('emergency stop latches before I/O and targets only BabyTracker sessions', async t => {
  const f = fixture(t); let latchBeforeFirstCommand = false;
  const native = f.adapter.command; f.adapter.command = async (...args) => { latchBeforeFirstCommand = f.controller.state.mode === 'emergency'; return native(...args); };
  await f.controller.stop(true);
  assert.equal(latchBeforeFirstCommand, true);
  assert.equal(f.controller.state.mode, 'emergency'); assert.equal(f.controller.state.emergency.remaining, 0);
  assert.deepEqual(f.state.commands.map(x => x.id).sort(), ['baby-worker-1', 'baby-worker-2']);
  assert.ok(f.state.commands.every(x => x.action === 'kill')); assert.equal(f.state.sessions[2].isTerminated, false);
});
test('Graceful Stop, Pause, and controller restart cannot downgrade the emergency latch', async t => {
  const f = fixture(t); await f.controller.stop(true); const count = f.state.commands.length;
  await f.controller.stop(false); f.controller.pause();
  assert.equal(f.controller.state.mode, 'emergency'); assert.equal(f.state.commands.length, count);
  const restarted = new FleetController(f.config, f.deps); assert.equal(restarted.state.mode, 'emergency');
  await assert.rejects(restarted.start(), /latched/);
});
test('late draining tick cannot clear a newer emergency latch', async t => {
  const f = fixture(t); f.controller.state.mode = 'draining'; const gate = deferred();
  let calls = 0; f.adapter.sessions = () => ++calls === 1 ? gate.promise : Promise.resolve([]);
  const tick = f.controller.tick(); await f.controller.stop(true); gate.resolve([]); await tick;
  assert.equal(f.controller.state.mode, 'emergency'); assert.equal(f.controller.state.emergency.phase, 'verified_stopped');
});
test('emergency cannot be released while BabyTracker sessions are still active', async t => {
  const f = fixture(t); f.state.fail = true; await f.controller.stop(true);
  assert.equal(f.controller.state.emergency.phase, 'unverified');
  await assert.rejects(f.controller.releaseEmergency(), /not yet verified/);
  assert.equal(f.controller.state.mode, 'emergency');
});
test('verified emergency release leaves dispatch paused', async t => {
  const f = fixture(t); await f.controller.stop(true); await f.controller.releaseEmergency();
  assert.equal(f.controller.state.mode, 'paused'); assert.equal(f.controller.state.emergency, null);
});
test('runtime outage leaves shutdown unverified, never a fabricated zero', async t => {
  const f = fixture(t); f.adapter.sessions = async () => { throw Error('offline'); };
  const result = await f.controller.stop(true);
  assert.equal(result.ok, false); assert.equal(f.controller.state.emergency.remaining, null);
  const snap = await f.controller.snapshot(); assert.equal(snap.runtime.online, false);
});
test('queue rejects duplicate issues, escaping paths, broad root scope and unknown dependencies', t => {
  const f = fixture(t); const task = { issue: 11, title: 'Review OCR import validation', files: ['app/api/imports/'] };
  f.controller.enqueue(task); assert.throws(() => f.controller.enqueue(task), /already/);
  for (const file of ['../secrets', '/data', 'C:\\Tools', '*', '.', './']) assert.throws(() => f.controller.enqueue({ ...task, issue: 12, files: [file] }), /scope|relative/);
  assert.throws(() => f.controller.enqueue({ ...task, issue: 12, dependencies: ['unknown'] }), /dependency/);
});
test('queue normalizes directories and rejects nested overlapping file ownership', async t => {
  const f = fixture(t); const one = f.controller.enqueue({ issue: 11, title: 'Review OCR implementation', files: ['app/api/imports/'] });
  const two = f.controller.enqueue({ issue: 12, title: 'Review import handling', files: ['app/api/imports/save.ts'] });
  assert.deepEqual(one.files, ['app/api/imports']); await f.controller.assign(one.id, 'baby-worker-1');
  await assert.rejects(f.controller.assign(two.id, 'baby-worker-2'), /overlaps/);
});
test('assignment to another project is refused and dependency acceptance gates dispatch', async t => {
  const f = fixture(t); const one = f.controller.enqueue({ issue: 11, title: 'First import requirement', files: ['app/a'] });
  const two = f.controller.enqueue({ issue: 12, title: 'Dependent review requirement', files: ['app/b'], dependencies: [one.id] });
  await assert.rejects(f.controller.assign(one.id, 'mjobs-worker-1'), /BabyTracker/);
  await f.controller.assign(two.id, 'baby-worker-2'); await f.controller.start();
  await assert.rejects(f.controller.dispatch('baby-worker-2'), /dependency/); assert.equal(f.state.commands.length, 0);
});
test('empty Turbo queue pauses instead of generating endless prompts', async t => {
  const f = fixture(t); await f.controller.start(); f.controller.turbo(true); await f.controller.tick();
  assert.equal(f.controller.state.mode, 'paused'); assert.equal(f.state.commands.length, 0);
});
test('queued task survives restart and no automation resumes', async t => {
  const f = fixture(t); const task = f.controller.enqueue({ issue: 11, title: 'Bounded parser regression', files: ['lib/import-parser.ts'] });
  await f.controller.assign(task.id, 'baby-worker-1'); await f.controller.start(); f.controller.turbo(true);
  const restarted = new FleetController(f.config, f.deps); await restarted.tick();
  assert.equal(restarted.state.mode, 'paused'); assert.equal(restarted.state.tasks[0].agentId, 'baby-worker-1');
  assert.equal(f.state.commands.length, 0);
});
test('corrupt or cross-project persisted state cannot be overwritten', t => {
  const f = fixture(t); const file = path.join(f.dir, 'controller.json');
  fs.writeFileSync(file, '{broken'); assert.throws(() => new FleetController(f.config, f.deps), /unreadable/); assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  fs.writeFileSync(file, JSON.stringify({ schema: 1, projectId: 'mjobs-luna', tasks: [] }));
  assert.throws(() => new FleetController(f.config, f.deps), /identity/);
});
