'use strict';
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const PROJECT = 'babytracker';
const SOURCE_REPO = 'MulattoTech/BabyTracker';
const ISSUE_REPO = 'MulattoTech/BabyTracker';

function configFromEnvironment(env = process.env) {
  const stateDir = path.resolve(env.BABYTRACKER_FLEET_STATE || path.join(os.homedir(), '.babytracker-fleet'));
  const port = Number(env.BABYTRACKER_FLEET_PORT || 4319);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid BabyTracker fleet port');
  const daemonUrl = env.BABYTRACKER_AO_URL || 'http://127.0.0.1:3001';
  const url = new URL(daemonUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/') {
    throw Error('Orchestrator must be a loopback HTTP origin without credentials');
  }
  const repoPath = path.resolve(env.BABYTRACKER_SOURCE_PATH || (process.platform === 'win32' ? 'C:\\Tools\\Dev\\BabyTracker' : path.join(os.homedir(), 'BabyTracker')));
  const aoPath = env.BABYTRACKER_AO_PATH || (process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'agent-orchestrator', 'resources', 'daemon', 'ao.exe') : '');
  const quotaFile = env.BABYTRACKER_CODEX_QUOTA_FILE || '';
  const codexExe = env.BABYTRACKER_CODEX_EXE || (process.platform === 'win32' ? path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe') : '');
  // Models are intentionally empty until verified for the installed CLI by the operator.
  // Merely copying an MJobs model list would not establish BabyTracker availability.
  const modelsFile = env.BABYTRACKER_MODELS_FILE;
  let codexModels = [];
  if (modelsFile) {
    const models = JSON.parse(fs.readFileSync(modelsFile, 'utf8').replace(/^\uFEFF/, ''));
    if (!Array.isArray(models) || models.some(m => !m || typeof m.id !== 'string' || !/^[a-z0-9._-]+$/i.test(m.id) || typeof m.name !== 'string')) throw Error('Invalid verified model catalog');
    codexModels = models;
  }
  // Enable only after verifying the live AO project maps to this repository/path.
  const runtimeVerified = env.BABYTRACKER_AO_PROJECT_VERIFIED === '1';
  return { projectId: PROJECT, sourceRepository: SOURCE_REPO, issueRepository: ISSUE_REPO, stateDir, port, daemonUrl: url.origin, repoPath, aoPath, quotaFile, codexExe, codexModels, runtimeVerified };
}

module.exports = { PROJECT, SOURCE_REPO, ISSUE_REPO, configFromEnvironment };
