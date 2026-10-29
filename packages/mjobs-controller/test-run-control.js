'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RunController } = require('./run-control');
const requestId = 'regression-request-001';
function fixture(t, initial = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mjobs-run-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let enabled = false;
  let current = { primaryId: 'mjobs-luna-1', ready: true, busy: false, idle: true, sessionIds: ['mjobs-luna-1'], ...initial };
  let quota = { fresh: true, blocked: false, remainingPercent: 80 };
  const calls = { launch: [], instruct: [], enable: 0 };
  const deps = {
    quota: () => quota, dispatchEnabled: () => enabled,
    pause: () => { enabled = false; }, blockReason: () => quota.blocked ? 'Provider allowance exhausted' : null,
    prepare: async check => { check(); return {}; }, inspect: async () => current,
    launch: async pending => {
      calls.launch.push(pending);
      current = { ...current, primaryId: pending.primaryId || 'mjobs-luna-2', ready: true, idle: true, busy: false, createdForRequest: pending.requestId };
    },
    instruct: async (primary, id) => { calls.instruct.push({ primary, id }); },
    enable: async check => { check(); enabled = true; calls.enable++; }
  };
  const controller = () => new RunController({ root, deps, pollMs: 0, readyTimeoutMs: 0 });
  return { root, deps, calls, controller, setCurrent: value => { current = value; }, setQuota: value => { quota = value; } };
}
test('a busy primary starts dispatch without steering active work', async t => {
  const f = fixture(t, { busy: true, idle: false }), run = f.controller();
  run.start({ requestId }); await run.waitForIdle();
  assert.equal(run.status().running, true); assert.equal(f.calls.instruct.length, 0); assert.equal(f.calls.launch.length, 0);
});
test('idle Start submits one prompt and coalesces duplicate and overlapping requests', async t => {
  const f = fixture(t), run = f.controller();
  run.start({ requestId }); run.start({ requestId }); run.start({ requestId: 'another-request-001' });
  await run.waitForIdle(); run.start({ requestId });
  assert.equal(f.calls.instruct.length, 1); assert.match(f.calls.instruct[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i); assert.equal(f.calls.enable, 1);
});
for (const kind of ['spawn', 'resume']) test(`${kind} is submitted once and verified before dispatch`, async t => {
  const f = fixture(t, { primaryId: kind === 'spawn' ? null : 'mjobs-luna-1', ready: false, busy: false, idle: false, sessionIds: kind === 'spawn' ? [] : ['mjobs-luna-1'] });
  const run = f.controller(); run.start({ requestId }); await run.waitForIdle();
  assert.equal(f.calls.launch.length, 1); assert.equal(f.calls.launch[0].kind, kind); assert.equal(f.calls.instruct.length, 1); assert.equal(run.status().running, true);
});
test('restart verifies a pending spawn without replaying its launch', async t => {
  const f = fixture(t, { primaryId: 'mjobs-luna-2', busy: true, idle: false, createdForRequest: requestId });
  fs.writeFileSync(path.join(f.root, 'run-state.json'), JSON.stringify({ schemaVersion: 1, phase: 'starting', requestId, pending: { kind: 'spawn', previousIds: [], requestId } }));
  const run = f.controller(); run.start({ requestId: 'restart-request-002' }); await run.waitForIdle();
  assert.equal(f.calls.launch.length, 0); assert.equal(run.status().running, true); assert.equal(run.status().pending, null);
});
test('unknown prompt outcome survives restart and blocks replay and dispatch', async t => {
  const f = fixture(t);
  const pending = { kind: 'send', primaryId: 'mjobs-luna-1', messageId: 'original-message', requestId };
  fs.writeFileSync(path.join(f.root, 'run-state.json'), JSON.stringify({ schemaVersion: 1, phase: 'starting', requestId, pending }));
  const run = f.controller(); run.start({ requestId: 'retry-request-002' }); await run.waitForIdle();
  assert.deepEqual(run.status().pending, pending); assert.equal(run.status().phase, 'uncertain'); assert.equal(f.calls.instruct.length, 0); assert.equal(f.calls.enable, 0);
});
test('Pause during awaited preparation fences all later work', async t => {
  const f = fixture(t); let release;
  f.deps.prepare = async () => new Promise(resolve => { release = resolve; });
  const run = f.controller(); run.start({ requestId }); await Promise.resolve(); run.pause(); release({}); await run.waitForIdle();
  assert.equal(run.status().phase, 'paused'); assert.equal(f.calls.instruct.length, 0); assert.equal(f.calls.enable, 0);
});
test('exhaustion pauses dispatch and a later reset never automatically enables it', async t => {
  const f = fixture(t, { busy: true, idle: false }), run = f.controller();
  run.start({ requestId }); await run.waitForIdle();
  f.setQuota({ fresh: true, blocked: true, remainingPercent: 0 }); run.observeQuota();
  assert.equal(run.status().running, false); assert.equal(run.status().phase, 'paused');
  f.setQuota({ fresh: true, blocked: false, remainingPercent: 100 }); run.observeQuota();
  assert.equal(run.status().running, false); assert.equal(f.calls.enable, 1);
});
test('definitely unsubmitted prompt may be retried, while unknown command failure preserves its ledger', async t => {
  for (const submitted of [false, undefined]) {
    const f = fixture(t); f.deps.instruct = async () => { throw Object.assign(Error('send failed'), submitted === false ? { nativeSubmitted: false } : {}); };
    const run = f.controller(); run.start({ requestId }); await run.waitForIdle();
    assert.equal(run.status().pending?.kind || null, submitted === false ? null : 'send'); assert.equal(f.calls.enable, 0);
  }
});
test('Pause during prompt delivery preserves submission receipt but never enables later dispatch', async t => {
  const f = fixture(t); let release;
  f.deps.instruct = async (primary, id) => { f.calls.instruct.push({ primary, id }); await new Promise(resolve => { release = resolve; }); };
  const run = f.controller(); run.start({ requestId });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  run.pause(); release(); await run.waitForIdle();
  assert.equal(f.calls.instruct.length, 1); assert.equal(f.calls.enable, 0); assert.equal(run.status().running, false); assert.equal(run.status().phase, 'paused');
});
test('independent idle Starts receive distinct native-compatible UUIDs', async t => {
  const f = fixture(t), run = f.controller();
  run.start({ requestId }); await run.waitForIdle(); run.pause();
  run.start({ requestId: 'independent-request-002' }); await run.waitForIdle();
  assert.equal(f.calls.instruct.length, 2);
  for (const instruction of f.calls.instruct) assert.match(instruction.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.notEqual(f.calls.instruct[0].id, f.calls.instruct[1].id);
});
