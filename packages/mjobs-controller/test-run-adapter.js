'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RunAdapter } = require('./run-adapter');
function fixture() {
  const commands = [], effects = [];
  const legacy = { revision: 'legacy-revision', phase: 'idle' };
  const restore = { state: { phase: 'complete', inflight: {}, errors: {} }, config: { minFreeRamGiB: 5, minFreeDiskGiB: 10, maxCpuPercent: 90 }, watchdogDisarmed: async () => true, resourceReader: async () => ({ ramGiB: 20, diskGiB: 100, cpuPercent: 10 }) };
  let sessions = [];
  const master = { restore, sustain: { config: { enabled: false }, enable: value => effects.push(['enable', value]) }, drainState: { enabled: false }, locked: () => false, disableAutomaticDispatch: () => effects.push(['pause']) };
  const quota = { status: () => ({ fresh: true }), prepareForStart: () => effects.push(['quota']), dispatchBlockReason: () => null };
  const adapter = new RunAdapter({ startup: { status: () => legacy }, master, quota, busy: () => false, verifyCodex: async () => {}, launcher: { reconcile: () => ({}) }, getSessions: async () => sessions, inspectProject: async () => ({ id: 'mjobs-luna', kind: 'single_repo', repo: 'https://github.com/MulattoTech/MJobs.git' }), command: async args => { commands.push(args); } });
  return { adapter, legacy, restore, master, quota, commands, effects, setSessions: value => { sessions = value; } };
}
function oldRejected(f) {
  Object.assign(f.legacy, { reconciliationRequired: true, phase: 'uncertain', runId: 'new-run', startedAt: '2026-10-29T12:00:00Z', error: { code: 'STARTUP_FAILED', message: 'Bounded restore requires only the saved MJobs primary and dispatch off' }, restoreStartAttempted: true, restoreStarted: false, restoreReceipt: null, actionPending: { name: 'start existing RestoreFleet' }, options: { expectedProjectId: 'mjobs-luna', boundedPrimaryId: 'mjobs-luna-1', startWorkAfter: false } });
  Object.assign(f.restore.state, { source: { startupRunId: 'older-run' }, completedAt: '2026-10-29T11:00:00Z' });
}
test('only exact precommit bounded rejection with a complete older ledger permits Start', () => {
  const f = fixture(); oldRejected(f); assert.equal(f.adapter.recoveryBlockReason(), null);
  for (const mutate of [
    f => { f.legacy.restoreReceipt = {}; }, f => { f.legacy.restoreStarted = true; },
    f => { f.legacy.error.message += '.'; }, f => { f.legacy.options.expectedProjectId = 'baby'; },
    f => { f.restore.state.source.startupRunId = f.legacy.runId; }, f => { f.restore.state.completedAt = '2026-10-29T13:00:00Z'; },
    f => { f.restore.state.phase = 'failed'; }, f => { f.restore.state.errors.old = { message: 'failure' }; }
  ]) { const bad = fixture(); oldRejected(bad); mutate(bad); assert.ok(bad.adapter.recoveryBlockReason()); }
});
test('unknown native recovery ledger always blocks current-primary Start', () => {
  const f = fixture(); oldRejected(f); f.restore.state.inflight['mjobs-luna-1'] = { operation: 'resume' };
  assert.match(f.adapter.recoveryBlockReason(), /unverified/);
});
test('foreign project sessions never become MJobs primaries or native mutation targets', async () => {
  const f = fixture(); f.setSessions([{ id: 'baby-1', projectId: 'baby', kind: 'orchestrator', harness: 'codex', mode: 'chat', activity: 'working', controllerVerified: true, controllerState: 'busy' }]);
  const current = await f.adapter.inspect(); assert.equal(current.primaryId, null); assert.deepEqual(current.sessionIds, []);
  await f.adapter.launch({ kind: 'spawn', previousIds: [], requestId: 'scope-request-001' }, () => {});
  assert.equal(f.commands.length, 1); const command = f.commands[0];
  assert.equal(command[command.indexOf('--project') + 1], 'mjobs-luna'); assert.ok(!command.includes('baby-1'));
  assert.equal(command[command.indexOf('--model') + 1], 'gpt-5.6-sol'); assert.equal(command[command.indexOf('--effort') + 1], 'medium');
});
test('zero allowance blocks preparation before watchdog release or launch', async () => {
  const f = fixture(); f.quota.dispatchBlockReason = () => 'Provider allowance exhausted';
  f.restore.watchdogDisarmed = async () => { assert.fail('watchdog must not be released after quota rejection'); };
  await assert.rejects(f.adapter.prepare(() => {}), /allowance exhausted/); assert.equal(f.commands.length, 0);
});
test('stale provider reading is refreshed and must pass preflight before launch', async () => {
  const f = fixture(); let reads = 0;
  f.quota.status = () => ({ fresh: ++reads > 1 });
  f.quota.dispatchBlockReason = () => 'Provider usage is stale';
  await assert.rejects(f.adapter.prepare(() => {}), /stale/); assert.equal(f.commands.length, 0);
});
test('watchdog release requires literal true rather than a truthy result object', async () => {
  const f = fixture(); let probes = 0, verified = false;
  f.restore.watchdogDisarmed = async () => { probes++; if (probes === 1) return { disarmed: false }; verified = true; return true; };
  f.restore.resourceReader = async () => { assert.equal(verified, true); return { ramGiB: 20, diskGiB: 100, cpuPercent: 10 }; };
  await f.adapter.prepare(() => {}); assert.equal(probes, 2); assert.equal(f.commands.length, 0);
});
test('instruction precheck failure explicitly proves no native submission', async () => {
  const f = fixture();
  await assert.rejects(f.adapter.instruct({ primaryId: 'mjobs-luna-1', mode: 'chat' }, 'message-id', () => {}), error => error.nativeSubmitted === false);
  assert.equal(f.commands.length, 0);
});
test('a failed native send remains an unknown submission rather than being labeled safe to replay', async () => {
  const f = fixture(); f.setSessions([{ id: 'mjobs-luna-1', projectId: 'mjobs-luna', kind: 'orchestrator', harness: 'codex', mode: 'chat', activity: 'idle', controllerVerified: true, controllerState: 'ready' }]);
  let submissions = 0;
  f.adapter.command = async () => { submissions++; throw Error('native process lost its response'); };
  await assert.rejects(f.adapter.instruct({ primaryId: 'mjobs-luna-1', mode: 'chat' }, 'original-message', () => {}), error => error.nativeSubmitted !== false);
  assert.equal(submissions, 1);
});
for (const kind of ['spawn', 'resume']) for (const restart of [false, true]) test(`real adapter waits for exact ${kind} initialization${restart ? ' after restart without replay' : ' on the first Start'}`, async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { RunController } = require('./run-control');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mjobs-adapter-run-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = fixture(), originalRequest = 'native-initialization-001';
  const pending = kind === 'spawn' ? { kind, requestId: originalRequest, previousIds: [] } : { kind, requestId: originalRequest, primaryId: 'mjobs-luna-1' };
  const base = { id: 'mjobs-luna-1', projectId: 'mjobs-luna', kind: 'orchestrator', harness: 'codex', mode: 'chat', model: 'gpt-5.6-sol', displayName: 'MJobs run ' + originalRequest };
  let launched = restart, initializingReads = 0, nativeLaunches = 0;
  f.adapter.getSessions = async () => {
    if (!launched) return kind === 'spawn' ? [] : [{ ...base, activity: 'exited', controllerVerified: true, controllerState: 'stopped' }];
    if (++initializingReads <= 2) return [{ ...base, activity: 'initializing', controllerVerified: false, controllerState: 'starting' }];
    return [{ ...base, activity: 'working', controllerVerified: true, controllerState: 'busy' }];
  };
  f.adapter.command = async args => { if (args[0] === 'spawn' || args[1] === 'resume-agent') { nativeLaunches++; launched = true; } else assert.fail('busy primary must receive no prompt'); };
  f.master.sustain.enable = enabled => { f.master.sustain.config.enabled = enabled; };
  f.master.disableAutomaticDispatch = () => { f.master.sustain.config.enabled = false; };
  // Preparation side effects are independent of native readiness; inspection,
  // launch, verification and enable use the real adapter implementation.
  f.adapter.prepare = async check => { check(); return {}; };
  if (restart) fs.writeFileSync(path.join(root, 'run-state.json'), JSON.stringify({ schemaVersion: 1, phase: 'starting', requestId: originalRequest, pending }));
  const run = new RunController({ root, deps: f.adapter.deps(), pollMs: 0, readyTimeoutMs: 1000 });
  run.start({ requestId: restart ? 'restart-initialization-002' : originalRequest }); await run.waitForIdle();
  assert.equal(run.status().running, true, run.status().error); assert.ok(initializingReads >= 3); assert.equal(nativeLaunches, restart ? 0 : 1); assert.equal(run.status().pending, null);
});
test('pending proof never legitimizes an unknown or foreign initializing primary', async () => {
  for (const changes of [{ displayName: 'unrelated request' }, { model: 'gpt-other' }, { id: 'mjobs-luna-9' }]) {
    const f = fixture();
    f.setSessions([{ id: 'mjobs-luna-1', projectId: 'mjobs-luna', kind: 'orchestrator', harness: 'codex', mode: 'chat', model: 'gpt-5.6-sol', displayName: 'MJobs run expected-request', activity: 'initializing', ...changes }]);
    const pending = changes.id ? { kind: 'resume', primaryId: 'mjobs-luna-1' } : { kind: 'spawn', requestId: 'expected-request', previousIds: [] };
    await assert.rejects(f.adapter.inspect({ pending }), /unverified/);
    assert.equal(f.commands.length, 0);
  }
});
