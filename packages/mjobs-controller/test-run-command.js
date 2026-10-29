'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { completeKnownPaste } = require('./terminal-delivery');
// Exercise the exact server command boundary without booting HTTP listeners,
// schedulers, native processes, AI sessions or user-machine integrations.
const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const start = source.indexOf('async function command('), end = source.indexOf('\nasync function daemon(', start);
assert.ok(start >= 0 && end > start, 'server command implementation must be extractable');
function fixture(t, { pauseBeforeExec = false, pauseAfterExec = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mjobs-command-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const currentRun = { task: {}, prepared: true, generation: 1, state: { phase: 'starting' } };
  const calls = { exec: 0, enters: 0, capture: 0, deliveries: 0, finishes: [] };
  const session = { id: 'mjobs-luna-1', mode: 'tui', harness: 'codex', activity: { state: 'idle' }, terminalGeneration: 'native-generation-1' };
  const message = 'Continue the next verified MJobs implementation task.';
  const pause = () => { currentRun.generation++; currentRun.state.phase = 'paused'; };
  const context = vm.createContext({
    require, root, currentRun, AO: 'fake-native-command', master: { locked: () => false },
    assertCanStartWork: () => {}, audit: () => {},
    dispatchLedger: { reserve: () => ({ id: 'reservation-1' }), attach() {}, finish: (id, receipt, outcome) => calls.finishes.push(outcome) },
    deliveryReceipts: { capture: () => ({}), inspect: () => null },
    daemon: async () => { if (pauseBeforeExec) pause(); return { sessions: [session] }; },
    exec: async () => { calls.exec++; if (pauseAfterExec) pause(); return { stdout: '{}' }; },
    completeKnownPaste: async options => {
      calls.deliveries++;
      return completeKnownPaste({ ...options, wait: async () => {}, receipt: null,
        bindingReader: () => ({ id: session.id, generation: session.terminalGeneration, port: 1234 }), ownerCheck: async () => {},
        transport: async () => ({ capture: async () => { calls.capture++; return '› ' + message; }, enter: () => { calls.enters++; }, close() {} }) });
    }
  });
  vm.runInContext(source.slice(start, end) + '\nthis.nativeCommand = command;', context);
  return { calls, submit: () => context.nativeCommand(['send', '--session', session.id, '--message', message], 30000, { runStart: true }) };
}
test('Pause before native execution cancels the reservation and proves no submission', async t => {
  const f = fixture(t, { pauseBeforeExec: true });
  await assert.rejects(f.submit(), error => error.nativeSubmitted === false && /superseded/.test(error.message));
  assert.equal(f.calls.exec, 0); assert.equal(f.calls.deliveries, 0); assert.equal(f.calls.enters, 0); assert.deepEqual(f.calls.finishes, ['cancelled']);
});
test('Pause after native execution prevents terminal completion Enter and preserves uncertainty', async t => {
  const f = fixture(t, { pauseAfterExec: true });
  await assert.rejects(f.submit(), error => error.nativeSubmitted === true && /superseded/.test(error.message));
  assert.equal(f.calls.exec, 1); assert.equal(f.calls.deliveries, 1); assert.equal(f.calls.enters, 0); assert.deepEqual(f.calls.finishes, ['uncertain']);
});
test('the same terminal completion path can send one Enter while Start remains authorized', async t => {
  const f = fixture(t);
  await assert.rejects(f.submit(), error => error.nativeSubmitted === true && /unverified/.test(error.message));
  assert.equal(f.calls.exec, 1); assert.equal(f.calls.capture, 2); assert.equal(f.calls.enters, 1);
});
