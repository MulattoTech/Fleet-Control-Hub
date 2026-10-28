'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createSupervisor } = require('../run');

function fixture(options = {}) {
  const children = [], scheduled = [], cancelled = [], watches = [], cancelledWatches = [];
  const supervisor = createSupervisor({ watchWrapper: false, forkChild: (...args) => { const child = new EventEmitter(); child.args = args; child.kills = []; child.kill = signal => child.kills.push(signal); children.push(child); return child; }, schedule: fn => { scheduled.push(fn); return scheduled.length; }, cancel: id => cancelled.push(id), scheduleWatch: fn => { watches.push(fn); return watches.length; }, cancelWatch: id => cancelledWatches.push(id), log: () => {}, ...options });
  supervisor.start(); return { supervisor, children, scheduled, cancelled, watches, cancelledWatches };
}
test('supervisor stop during crash backoff cancels pending restart and fences late callbacks', () => {
  const f = fixture(); f.children[0].emit('exit', 1); assert.equal(f.scheduled.length, 1);
  f.supervisor.stop(); assert.deepEqual(f.cancelled, [1]);
  f.scheduled[0](); assert.equal(f.children.length, 1); assert.deepEqual(f.children[0].kills, ['SIGTERM']);
});
test('only a requested restart replaces the owned child immediately', () => {
  const f = fixture(); f.children[0].emit('message', { type: 'babytracker-restart' }); f.children[0].emit('exit', 75);
  assert.equal(f.children.length, 2); assert.equal(f.scheduled.length, 0);
  assert.equal(f.children[1].args[2].windowsHide, true); f.supervisor.stop(); assert.deepEqual(f.children[1].kills, ['SIGTERM']);
});
test('unrequested restart exit code uses crash backoff and does not silently restart immediately', () => {
  const f = fixture(); f.children[0].emit('exit', 75); assert.equal(f.children.length, 1); assert.equal(f.scheduled.length, 1); f.supervisor.stop();
});
test('verified wrapper death stops only the owned child, clears the watch and fences late callbacks', () => {
  let gone = false; const probes = [];
  const f = fixture({ watchWrapper: true, wrapperPid: 4242, probeWrapper: pid => { probes.push(pid); if (gone) throw Object.assign(Error('parent exited'), { code: 'ESRCH' }); } });
  assert.equal(f.children.length, 1); assert.equal(f.watches.length, 1);
  gone = true; f.watches[0]();
  assert.deepEqual(f.children[0].kills, ['SIGTERM']); assert.deepEqual(f.cancelledWatches, [1]); assert.deepEqual(probes, [4242, 4242]);
  f.watches[0](); f.supervisor.stop(); f.children[0].emit('exit', 1);
  assert.deepEqual(f.children[0].kills, ['SIGTERM']); assert.equal(f.scheduled.length, 0); assert.equal(probes.length, 2);
});
test('wrapper death during crash backoff cancels restart without creating another child', () => {
  let gone = false;
  const f = fixture({ watchWrapper: true, wrapperPid: 4242, probeWrapper: () => { if (gone) throw Object.assign(Error('gone'), { code: 'ESRCH' }); } });
  f.children[0].emit('exit', 1); gone = true; f.watches[0]();
  assert.deepEqual(f.cancelled, [1]); assert.deepEqual(f.cancelledWatches, [1]);
  f.scheduled[0](); assert.equal(f.children.length, 1);
});
test('permission or unknown wrapper-probe errors do not establish death or terminate a child', () => {
  let code = 'EPERM';
  const f = fixture({ watchWrapper: true, wrapperPid: 4242, probeWrapper: () => { throw Object.assign(Error('unverified'), { code }); } });
  f.watches[0](); code = 'EACCES'; f.watches[0](); code = undefined; f.watches[0]();
  assert.equal(f.children.length, 1); assert.deepEqual(f.children[0].kills, []); assert.deepEqual(f.cancelledWatches, []);
  f.supervisor.stop(); assert.deepEqual(f.children[0].kills, ['SIGTERM']); assert.deepEqual(f.cancelledWatches, [1]);
});
test('a wrapper already confirmed dead prevents the initial child launch', () => {
  const f = fixture({ watchWrapper: true, wrapperPid: 4242, probeWrapper: () => { throw Object.assign(Error('gone'), { code: 'ESRCH' }); } });
  assert.equal(f.children.length, 0); assert.deepEqual(f.cancelledWatches, [1]);
});
test('manual launches do not activate a wrapper watcher', () => {
  const f = fixture({ watchWrapper: false, probeWrapper: () => { throw Error('must not probe'); } });
  assert.equal(f.watches.length, 0); assert.equal(f.children.length, 1); f.supervisor.stop();
});
test('two stale-lock recovery contenders cannot both own the same state', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'babytracker-lock-race-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const departed = spawn(process.execPath, ['-e', 'process.exit(0)']); const oldPid = departed.pid;
  await new Promise((resolve, reject) => { departed.on('exit', resolve); departed.on('error', reject); });
  fs.writeFileSync(path.join(dir, 'controller.lock'), JSON.stringify({ pid: oldPid, nonce: 'old' }));
  const script = `const {acquireLock}=require(${JSON.stringify(path.resolve(__dirname, '../server.js'))});try{const release=acquireLock(process.argv[1]);process.stdout.write('OWNED');setTimeout(()=>{release();process.exit(0)},700)}catch(e){process.stdout.write('BLOCKED');process.exit(2)}`;
  const run = () => new Promise((resolve, reject) => { const child = spawn(process.execPath, ['-e', script, dir], { stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; child.stdout.on('data', d => { output += d; }); child.on('error', reject); child.on('exit', code => resolve({ code, output })); });
  const results = await Promise.all([run(), run()]); assert.equal(results.filter(r => r.output === 'OWNED').length, 1); assert.equal(results.filter(r => r.output === 'BLOCKED').length, 1);
});
