'use strict';
const fs = require('node:fs');
const { PROJECT, SOURCE_REPO } = require('./config');
const { repositoryId, sameDirectory } = require('./bootstrap');
const { validateSelection } = require('./vendor/mjobs/provider-catalog');

const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{2,79}$/;
const active = s => s && !s.isTerminated && !['exited','terminated','stopped','failed']
  .includes(s.activity?.state || s.activity || s.status);
const cleanJSON = (value, label) => {
  if (!value || typeof value.stdout !== 'string' || value.stdout.length > 100000) throw Error(label + ' unavailable');
  try { return JSON.parse(value.stdout.replace(/^\uFEFF/, '')); }
  catch { throw Error(label + ' returned malformed JSON'); }
};
function validateAgentInput(input, catalog) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Agent request is required');
  if (typeof input.name !== 'string' || !NAME.test(input.name) || input.name.trim() !== input.name) throw Error('Agent display name must be 3-80 simple characters');
  const kind = input.kind || 'worker';
  if (!['worker', 'orchestrator'].includes(kind)) throw Error('Agent role must be worker or orchestrator');
  const selection = validateSelection({ harness: input.harness, model: input.model, effort: input.effort, mode: input.harness === 'agy' ? 'tui' : 'chat' }, catalog);
  if (!['codex','agy'].includes(selection.harness)) throw Error('Only verified Codex and AGY are supported');
  return { ...selection, name: input.name, kind };
}
async function provisionAgent(config, {
  runner, sessions, selection, onSubmit = () => {},
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
}) {
  if (!config.runtimeVerified) throw Error('BabyTracker binding is not verified');
  if (!config.aoPath || !fs.statSync(config.aoPath, { throwIfNoEntry: false })?.isFile()) throw Error('Configured AO binary unavailable');
  if (!config.repoPath || !fs.statSync(config.repoPath, { throwIfNoEntry: false })?.isDirectory()) throw Error('BabyTracker source unavailable');
  if (!selection || !['codex','agy'].includes(selection.harness) ||
      selection.mode !== (selection.harness === 'agy' ? 'tui' : 'chat') ||
      !NAME.test(selection.name) || !['worker','orchestrator'].includes(selection.kind)) throw Error('Unvalidated agent selection');
  const run = (args, timeout = 15000) => runner(config.aoPath, args, {
    cwd: config.repoPath, windowsHide: true, maxBuffer: 100000, timeout
  });
  const project = cleanJSON(await run(['project','get',PROJECT,'--json']), 'AO project').project;
  if (!project || project.id !== PROJECT || project.kind !== 'single_repo' ||
      !sameDirectory(project.path, config.repoPath) ||
      repositoryId(project.repo) !== SOURCE_REPO.toLowerCase()) {
    throw Error('AO BabyTracker GitHub repository or local project path changed');
  }
  const agents = cleanJSON(await run(['agent','ls','--json']), 'AO agent readiness').supported;
  if (!Array.isArray(agents) || !agents.some(a => a.id === selection.harness && a.authStatus === 'authorized')) {
    throw Error('Chosen agent provider is not currently authorized in AO');
  }
  const before = await sessions();
  if (!Array.isArray(before)) throw Error('Live AO sessions unavailable');
  if (before.some(s => active(s) && s.projectId === PROJECT && s.displayName === selection.name)) throw Error('An active BabyTracker agent already uses this name');
  const originalIds = new Set(before.map(s => s.id));
  const argv = ['spawn','--project',PROJECT,'--kind',selection.kind,
    '--harness',selection.harness,'--mode',selection.mode,'--name',selection.name,'--model',selection.model];
  if (selection.effortMode === 'flag' && selection.launchEffort) argv.push('--effort',selection.launchEffort);
  onSubmit({ existingIds: [...originalIds].filter(s => /^[a-z0-9][a-z0-9-]{2,89}$/.test(s)), name: selection.name,
    harness: selection.harness, kind: selection.kind });
  try { await run(argv, 30000); }
  catch (error) {
    // Native AO diagnostic, not the full command line or environmental secrets.
    const detail = String(error?.stderr || '').replace(/\x1B\[[0-9;]*m/g, '')
      .replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f]+/g, '')
      .slice(0, 350);
    throw Error('AO rejected ' + selection.harness + ' spawn' +
      (detail ? ': ' + detail : ' (no diagnostic stderr returned)'));
  }
  for (let i = 0; i < 16; i++) {
    const after = await sessions();
    if (!Array.isArray(after)) throw Error('Live AO session verification unavailable');
    const found = after.filter(s => !originalIds.has(s.id) && active(s) && s.projectId === PROJECT &&
      s.harness === selection.harness && s.kind === selection.kind && s.displayName === selection.name);
    if (found.length === 1) return { id: found[0].id, created: true, harness: selection.harness, model: selection.model };
    if (found.length > 1) throw Error('Multiple matching AO sessions created; reconcile before any retry');
    if (i < 15) await sleep(300);
  }
  throw Error('Native spawn was submitted but the exact project-owned session could not be verified');
}
module.exports = { provisionAgent, validateAgentInput, active };
