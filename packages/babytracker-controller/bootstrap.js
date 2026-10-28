'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { PROJECT, SOURCE_REPO } = require('./config');

// This is only the first Codex orchestrator bootstrap, not unrestricted
// worker provisioning or an instruction to begin autonomous paid work.
const BOOTSTRAP_NAME = 'BabyTracker Orchestrator';

const isLive = s => s && !s.isTerminated &&
  !['exited', 'terminated', 'stopped', 'failed'].includes(s.activity?.state || s.activity || s.status);
const isCodex = s => isLive(s) && s.projectId === PROJECT && s.harness === 'codex';

function repositoryId(remote) {
  if (typeof remote !== 'string') return null;
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(remote);
  return match ? match[1].toLowerCase() : null;
}
function sameDirectory(a, b) {
  if (typeof a !== 'string' || !a || typeof b !== 'string' || !b) return false;
  try {
    const normalize = p => fs.realpathSync(p).replace(/[\\/]+$/, '').toLowerCase();
    return normalize(a) === normalize(b);
  } catch { return false; }
}

function parseCommand(output, label) {
  if (!output || typeof output.stdout !== 'string' || output.stdout.length > 100000) {
    throw Error(label + ' did not provide a bounded JSON response');
  }
  try { return JSON.parse(output.stdout.replace(/^\uFEFF/, '')); }
  catch { throw Error(label + ' returned invalid JSON'); }
}

// AO's successful exit does not prove a session was created. Keep only bounded,
// allowlisted response metadata if verification fails; never retain raw CLI output.
function spawnResponseHint(result) {
  const stdout = typeof result?.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result?.stderr === 'string' ? result.stderr : '';
  const sample = (stdout + '\n' + stderr).slice(0, 100000);
  const flags = ['queued', 'created', 'spawned', 'error', 'failed', 'warning',
    'unauthorized', 'permission', 'project', 'workspace', 'timeout']
    .filter(word => new RegExp('\\b' + word + '\\b', 'i').test(sample));
  const sessionIds = [...new Set(sample.match(/\bbabytracker-\d{1,6}\b/g) || [])].slice(0, 3);
  return 'AO response bytes=' + Math.min(Buffer.byteLength(stdout), 100000) + '/' +
    Math.min(Buffer.byteLength(stderr), 100000) +
    '; flags=' + (flags.join(',') || 'none') +
    '; sessionHints=' + (sessionIds.join(',') || 'none');
}

async function provisionFirstCodex(config, { runner, sessions, onSubmit = () => {}, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (!config.runtimeVerified) throw Error('BabyTracker AO project binding is not verified');
  if (!config.aoPath || !fs.statSync(config.aoPath, { throwIfNoEntry: false })?.isFile()) {
    throw Error('Configured AO executable is not available');
  }
  if (!config.repoPath || !fs.statSync(config.repoPath, { throwIfNoEntry: false })?.isDirectory()) {
    throw Error('BabyTracker application checkout is not available');
  }
  const run = (args, timeout = 15000) => runner(config.aoPath, args, {
    windowsHide: true, timeout, maxBuffer: 100000, cwd: config.repoPath
  });
  // Do not accept a cached "project verified" switch as proof when creating a
  // new process. Check AO's actual project and Codex authentication first.
  const project = parseCommand(await run(['project', 'get', PROJECT, '--json']), 'AO project inspection').project;
  if (!project || project.id !== PROJECT || project.kind !== 'single_repo' ||
      !sameDirectory(project.path, config.repoPath) ||
      repositoryId(project.repo) !== SOURCE_REPO.toLowerCase()) {
    throw Error('AO project/repository/path binding has changed; no BabyTracker session was created');
  }
  const agents = parseCommand(await run(['agent', 'ls', '--json']), 'AO provider inspection').supported;
  if (!Array.isArray(agents) ||
      !agents.some(agent => agent.id === 'codex' && agent.authStatus === 'authorized')) {
    throw Error('Codex is not currently authorized in the AO agent catalog');
  }
  const before = await sessions();
  if (!Array.isArray(before)) throw Error('AO session inspection is unavailable');
  const existing = before.find(isCodex);
  if (existing) return { id: existing.id, created: false };
  const previousIds = new Set(before.map(s => s.id));
  onSubmit(); // Persist an uncertain-delivery latch before the first native mutation.
  const spawnResult = await run(['spawn', '--project', PROJECT, '--kind', 'orchestrator',
    '--harness', 'codex', '--mode', 'chat', '--name', BOOTSTRAP_NAME], 30000);
  const responseHint = spawnResponseHint(spawnResult);
  for (let attempt = 0; attempt < 16; attempt++) {
    const after = await sessions();
    if (!Array.isArray(after)) throw Error('AO session verification is unavailable');
    const found = after.filter(s => !previousIds.has(s.id) && isCodex(s) &&
      s.kind === 'orchestrator' && s.displayName === BOOTSTRAP_NAME);
    if (found.length === 1) return { id: found[0].id, created: true };
    if (found.length > 1) throw Error('Multiple new BabyTracker orchestrators appeared; manual reconciliation required');
    if (attempt < 15) await sleep(300);
  }
  throw Error('AO accepted provisioning but the new BabyTracker session could not be verified; no automatic retry. ' + responseHint);
}

module.exports = { provisionFirstCodex, isCodex, repositoryId, sameDirectory, BOOTSTRAP_NAME };
