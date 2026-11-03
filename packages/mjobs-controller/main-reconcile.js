'use strict';
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomBytes } = require('node:crypto');
const exec = promisify(execFile);

const SHA = /^[0-9a-f]{40,64}$/;
const NORMAL_TIMEOUT_MS = 12000;
const FETCH_TIMEOUT_MS = 45000;

function createMainReconciler({ repoDir, run = exec, now = () => new Date(), random = () => randomBytes(3).toString('hex') }) {
  if (typeof repoDir !== 'string' || !repoDir) throw Error('MJobs repository directory is required');
  const checkSha = value => {
    const sha = String(value || '').trim();
    if (!SHA.test(sha)) throw Error('Git main identity is missing or invalid; no fleet launch was requested');
    return sha;
  };
  async function git(args, timeout = NORMAL_TIMEOUT_MS) {
    try {
      const result = await run('git', ['-C', repoDir, ...args], {
        windowsHide: true, timeout, maxBuffer: 512 * 1024, encoding: 'utf8'
      });
      return String(result.stdout || '').trim();
    } catch (error) {
      const reason = String(error.stderr || error.message || 'unknown error').trim().replace(/\s+/g, ' ').slice(0, 240);
      throw Error('MJobs Git ' + args[0] + ' unavailable: ' + reason);
    }
  }
  async function remoteHead() {
    const output = await git(['ls-remote', 'origin', 'refs/heads/main']);
    const line = output.split(/\r?\n/).find(value => /^[0-9a-f]{40,64}\s+refs\/heads\/main$/.test(value.trim()));
    if (!line) throw Error('GitHub main could not be verified; no fleet launch was requested');
    return checkSha(line.trim().split(/\s+/)[0]);
  }
  async function verifyCheckout(expected = null) {
    const branch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (branch !== 'main') throw Error('MJobs checkout is not on main; preserve the current branch and switch it deliberately');
    const head = checkSha(await git(['rev-parse', 'HEAD']));
    if (expected && head !== expected) throw Error('MJobs main changed during startup reconciliation; retry after reviewing the new HEAD');
    const changes = await git(['status', '--porcelain=v1', '--untracked-files=normal']);
    if (changes) throw Error('MJobs main contains uncommitted or untracked work; preserve it in its own worktree before startup');
    return head;
  }
  async function ensureCurrent(check = () => {}) {
    check();
    const previousHead = await verifyCheckout();
    check();
    const advertisedHead = await remoteHead();
    check();
    if (previousHead === advertisedHead) {
      return { updated: false, previousHead, head: previousHead, safetyBranch: null };
    }
    // Fetch the advertised exact head; never reset, force, rebase or delete a worktree.
    await git(['fetch', '--no-tags', 'origin', 'main'], FETCH_TIMEOUT_MS);
    check();
    const fetchedHead = checkSha(await git(['rev-parse', 'FETCH_HEAD']));
    if (fetchedHead !== advertisedHead) throw Error('GitHub main advanced while fetching; retry startup after a fresh check');
    try {
      await run('git', ['-C', repoDir, 'merge-base', '--is-ancestor', previousHead, fetchedHead], {
        windowsHide: true, timeout: NORMAL_TIMEOUT_MS, maxBuffer: 512 * 1024, encoding: 'utf8'
      });
    } catch (error) {
      if (error.code === 1) throw Error('MJobs main diverged from GitHub; no automatic merge or fleet launch was performed');
      throw Error('MJobs ancestry could not be verified; no fleet launch was performed');
    }
    check();
    await verifyCheckout(previousHead);
    check();
    const stamp = now().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
    const safetyBranch = 'safety/pre-fleet-start-' + stamp + '-' + previousHead.slice(0, 8) + '-' + random();
    await git(['branch', safetyBranch, previousHead]);
    check();
    // Git's native index and ref locks protect the sole clean-main fast-forward.
    await git(['merge', '--ff-only', fetchedHead], FETCH_TIMEOUT_MS);
    check();
    const head = await verifyCheckout(fetchedHead);
    const latest = await remoteHead();
    if (latest !== head) throw Error('MJobs main advanced again during preparation; safe sync was saved, but retry Start for the newest work');
    return { updated: true, previousHead, head, safetyBranch };
  }
  return Object.freeze({ ensureCurrent });
}

module.exports = { createMainReconciler };
