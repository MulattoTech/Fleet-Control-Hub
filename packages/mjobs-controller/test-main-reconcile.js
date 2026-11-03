'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createMainReconciler } = require('./main-reconcile');

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', windowsHide: true, timeout: 12000 }).trim();
}
function commit(dir, content) {
  fs.writeFileSync(path.join(dir, 'source.txt'), content);
  git('-C', dir, 'add', 'source.txt');
  git('-C', dir, '-c', 'commit.gpgsign=false', '-c', 'user.name=Fleet Test',
    '-c', 'user.email=fleet-test@example.invalid', 'commit', '-m', 'fixture');
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjobs-main-reconcile-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const origin = path.join(dir, 'origin.git');
  const seed = path.join(dir, 'seed');
  const checkout = path.join(dir, 'checkout');
  git('init', '--bare', origin);
  git('--git-dir=' + origin, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git('init', '-b', 'main', seed);
  commit(seed, 'one');
  git('-C', seed, 'remote', 'add', 'origin', origin);
  git('-C', seed, 'push', '-u', 'origin', 'main');
  git('clone', origin, checkout);
  const reconciler = createMainReconciler({ repoDir: checkout, random: () => 'abc123',
    now: () => new Date('2026-11-03T12:00:00.000Z') });
  return { origin, seed, checkout, reconciler };
}
test('up-to-date clean main permits Start preflight without writing a branch', async t => {
  const f = fixture(t);
  const before = git('-C', f.checkout, 'rev-parse', 'HEAD');
  const result = await f.reconciler.ensureCurrent();
  assert.equal(result.updated, false);
  assert.equal(result.head, before);
  assert.equal(git('-C', f.checkout, 'branch', '--list', 'safety/pre-fleet-start-*'), '');
});
test('remote-ahead clean main safely fast-forwards and preserves old head', async t => {
  const f = fixture(t);
  const before = git('-C', f.checkout, 'rev-parse', 'HEAD');
  commit(f.seed, 'two');
  git('-C', f.seed, 'push', 'origin', 'main');
  const result = await f.reconciler.ensureCurrent();
  assert.equal(result.updated, true);
  assert.equal(result.previousHead, before);
  assert.equal(result.head, git('-C', f.seed, 'rev-parse', 'HEAD'));
  assert.equal(git('-C', f.checkout, 'rev-parse', result.safetyBranch), before);
  assert.equal(git('-C', f.checkout, 'status', '--porcelain'), '');
});
test('dirty local main fails closed without fetching or touching work', async t => {
  const f = fixture(t);
  const before = git('-C', f.checkout, 'rev-parse', 'HEAD');
  fs.appendFileSync(path.join(f.checkout, 'source.txt'), 'user edit');
  commit(f.seed, 'two');
  git('-C', f.seed, 'push', 'origin', 'main');
  await assert.rejects(f.reconciler.ensureCurrent(), /uncommitted or untracked/);
  assert.equal(git('-C', f.checkout, 'rev-parse', 'HEAD'), before);
  assert.match(fs.readFileSync(path.join(f.checkout, 'source.txt'), 'utf8'), /user edit/);
});
test('diverged main cannot be merged or reset automatically', async t => {
  const f = fixture(t);
  commit(f.checkout, 'local private change');
  const before = git('-C', f.checkout, 'rev-parse', 'HEAD');
  commit(f.seed, 'independent remote change');
  git('-C', f.seed, 'push', 'origin', 'main');
  await assert.rejects(f.reconciler.ensureCurrent(), /diverged/);
  assert.equal(git('-C', f.checkout, 'rev-parse', 'HEAD'), before);
  assert.equal(git('-C', f.checkout, 'branch', '--list', 'safety/pre-fleet-start-*'), '');
});
test('missing remote fails before any native agent launch or branch mutation', async t => {
  const f = fixture(t);
  const before = git('-C', f.checkout, 'rev-parse', 'HEAD');
  git('-C', f.checkout, 'remote', 'remove', 'origin');
  await assert.rejects(f.reconciler.ensureCurrent(), /Git ls-remote unavailable/);
  assert.equal(git('-C', f.checkout, 'rev-parse', 'HEAD'), before);
});
test('caller cancellation stops before a source update', async t => {
  const f = fixture(t);
  const before = git('-C', f.checkout, 'rev-parse', 'HEAD');
  commit(f.seed, 'two');
  git('-C', f.seed, 'push', 'origin', 'main');
  let reads = 0;
  await assert.rejects(f.reconciler.ensureCurrent(() => {
    if (++reads === 3) throw Error('User paused start');
  }), /User paused/);
  assert.equal(git('-C', f.checkout, 'rev-parse', 'HEAD'), before);
});
