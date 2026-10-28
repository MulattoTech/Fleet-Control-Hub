'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { provisionFirstCodex, repositoryId } = require('../bootstrap');
const { PROJECT, SOURCE_REPO } = require('../config');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'babytracker-bootstrap-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const project = { id: PROJECT, kind: 'single_repo', path: dir, repo: 'https://github.com/MulattoTech/BabyTracker.git' };
  const config = { runtimeVerified: true, aoPath: process.execPath, repoPath: dir };
  const state = {
    project, authorized: true, called: [], submitted: 0,
    sessions: [{ id: 'mjobs-alive', projectId: 'mjobs-luna', harness: 'codex', kind: 'orchestrator', activity: { state: 'idle' }, isTerminated: false }]
  };
  const runner = async (exe, args, opts) => {
    assert.equal(exe, process.execPath);
    assert.equal(opts.cwd, dir);
    assert.equal(opts.windowsHide, true);
    assert.equal(opts.shell, undefined);
    state.called.push([...args]);
    if (args[0] === 'project') return { stdout: JSON.stringify({ status: 'ok', project: state.project }) };
    if (args[0] === 'agent') return { stdout: JSON.stringify({ supported: [{ id: 'codex', authStatus: state.authorized ? 'authorized' : 'unauthorized' }] }) };
    if (args[0] !== 'spawn') throw Error('Unknown AO command');
    if (state.spawnFailure) throw Error('AO connection interrupted');
    state.sessions.push({ id: 'baby-bootstrap-1', projectId: PROJECT, harness: 'codex', kind: 'orchestrator', displayName: 'BabyTracker Orchestrator', activity: { state: 'idle' }, isTerminated: false });
    return { stdout: 'Spawned' };
  };
  const deps = { runner, sessions: async () => structuredClone(state.sessions), sleep: async () => {} };
  return { dir, config, state, deps };
}

test('canonical repository ID accepts only the expected github transport patterns', () => {
  assert.equal(repositoryId('https://github.com/MulattoTech/BabyTracker.git'), SOURCE_REPO.toLowerCase());
  assert.equal(repositoryId('git@github.com:MulattoTech/BabyTracker.git'), SOURCE_REPO.toLowerCase());
  assert.equal(repositoryId('https://other.example/owner/repo'), null);
  assert.equal(repositoryId('https://user:pass@github.com/MulattoTech/BabyTracker.git'), null);
});

test('verified explicit first bootstrap creates one Codex orchestrator under BabyTracker and no others', async t => {
  const f = fixture(t);
  let beforeSpawn = 0;
  const result = await provisionFirstCodex(f.config, { ...f.deps, onSubmit: () => { beforeSpawn++; } });
  assert.deepEqual(result, { id: 'baby-bootstrap-1', created: true });
  assert.equal(beforeSpawn, 1);
  assert.deepEqual(f.state.called.find(x => x[0] === 'spawn'), ['spawn', '--project', 'babytracker', '--kind', 'orchestrator', '--harness', 'codex', '--mode', 'chat', '--name', 'BabyTracker Orchestrator']);
  assert.equal(f.state.sessions[0].projectId, 'mjobs-luna');
  assert.equal(f.state.sessions.length, 2);
  const again = await provisionFirstCodex(f.config, { ...f.deps, onSubmit: () => { beforeSpawn++; } });
  assert.deepEqual(again, { id: 'baby-bootstrap-1', created: false });
  assert.equal(f.state.called.filter(x => x[0] === 'spawn').length, 1);
  assert.equal(beforeSpawn, 1);
});

test('wrong project/repository/path or unauthorized Codex fails before first native spawn', async t => {
  const f = fixture(t);
  for (const mutate of [
    () => { f.state.project.path = path.join(f.dir, 'different'); },
    () => { f.state.project.path = f.dir; f.state.project.repo = 'https://github.com/MulattoTech/MJobs.git'; },
    () => { f.state.project.repo = 'https://github.com/MulattoTech/BabyTracker.git'; f.state.authorized = false; }
  ]) {
    mutate();
    await assert.rejects(provisionFirstCodex(f.config, { ...f.deps, onSubmit: () => { throw Error('Must not submit'); } }), /binding|authorized/);
    assert.equal(f.state.called.filter(x => x[0] === 'spawn').length, 0);
  }
});

test('disabled or missing AO executable fails closed with no spawn', async t => {
  const f = fixture(t);
  f.config.runtimeVerified = false;
  await assert.rejects(provisionFirstCodex(f.config, f.deps), /not verified/);
  f.config.runtimeVerified = true; f.config.aoPath = path.join(f.dir, 'absent.exe');
  await assert.rejects(provisionFirstCodex(f.config, f.deps), /not available/);
  assert.equal(f.state.called.length, 0);
});

test('a failed native submission is not retried automatically', async t => {
  const f = fixture(t); f.state.spawnFailure = true;
  let submitting = 0;
  await assert.rejects(provisionFirstCodex(f.config, { ...f.deps, onSubmit: () => { submitting++; } }), /connection interrupted/);
  assert.equal(submitting, 1);
  assert.equal(f.state.called.filter(x => x[0] === 'spawn').length, 1);
});

test('unverified spawn records bounded allowlisted diagnostics without raw CLI output', async t => {
  const f = fixture(t);
  const original = f.deps.runner;
  let spawnAttempts = 0;
  f.deps.runner = async (...args) => {
    if (args[1][0] === 'spawn') {
      spawnAttempts++;
      return { stdout: 'queued babytracker-7 Bearer exampleSecret user@example.com C:\\Private\\record', stderr: 'warning' };
    }
    return original(...args);
  };
  await assert.rejects(provisionFirstCodex(f.config, f.deps), error => {
    assert.match(error.message, /AO response bytes=\d+\/\d+; flags=queued,warning; sessionHints=babytracker-7/);
    assert.doesNotMatch(error.message, /exampleSecret|user@example.com|Private|Bearer/);
    assert.ok(error.message.length < 250);
    return true;
  });
  assert.equal(spawnAttempts, 1);
});

test('unverifiable newly created identity fails closed instead of accepting another project', async t => {
  const f = fixture(t);
  const previous = f.deps.runner;
  f.deps.runner = async (...args) => {
    const result = await previous(...args);
    if (args[1][0] === 'spawn') f.state.sessions[1].projectId = 'mjobs-luna';
    return result;
  };
  await assert.rejects(provisionFirstCodex(f.config, f.deps), /could not be verified/);
});
