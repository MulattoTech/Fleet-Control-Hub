'use strict';

// One bounded fleet-session sweep. This runner never starts AO, selects OS
// processes for termination, kills them, or attaches to a shared Codex server.
// Native proof helpers may inspect a read-only process inventory. The native AO
// session API remains responsible for its exact owned runtime.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { attachWindowsStoppedEvidence, runtimeAbsentEvidence } = require('./windows-runtime-evidence');
const { attachExitedHostEvidence, runtimeExitedHostEvidence } = require('./exited-host-evidence');
const execAsync = promisify(execFile);
const AO_URL = 'http://127.0.0.1:3001';
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const ATTEMPTS_FILE = 'fleet-codex-stop-attempts.json';
const STATUS_FILE = 'emergency-status.json';
const FAILURE_MESSAGES = {
  AO_UNAVAILABLE: 'Orchestrator session feed is unavailable; fleet remains latched and no global process fallback is permitted.',
  AO_NATIVE_UNAVAILABLE: 'The exact Orchestrator native operation could not be verified; fleet remains latched.',
  AO_INVENTORY_INVALID: 'Orchestrator session membership is malformed or ambiguous; no global process fallback is permitted.',
  CAMPAIGN_INVALID: 'The active emergency campaign has no valid immutable timestamp or registered scope; native stops are blocked.',
  CAMPAIGN_CHANGED: 'The emergency campaign changed during this sweep; no further native stop was submitted.',
  ATTEMPTS_INVALID: 'Stop-attempt ledger is invalid; native stop submissions are blocked.',
  SCOPED_EVIDENCE_UNAVAILABLE: 'Scoped session or stop-attempt evidence unavailable; no global process fallback.'
};
function evidenceError(code) { return Object.assign(Error(FAILURE_MESSAGES[code]), { code }); }
function operationBudget(context, maximum) {
  if (context?.signal?.aborted) throw Error('Scoped watchdog deadline reached.');
  const remaining = typeof context?.remainingMs === 'function' ? context.remainingMs() : maximum;
  if (!Number.isFinite(remaining) || remaining <= 0) throw Error('Scoped watchdog deadline reached.');
  return Math.max(1, Math.min(maximum, Math.floor(remaining)));
}
function operationSignal(context, maximum) {
  const timeout = AbortSignal.timeout(operationBudget(context, maximum));
  return context?.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
}

function latchEnabled(root, io = fs) {
  try {
    const value = JSON.parse(io.readFileSync(path.join(root, 'emergency-latch.json'), 'utf8').replace(/^\uFEFF/, ''));
    return typeof value?.enabled === 'boolean' ? value.enabled : true;
  } catch (error) { return error.code === 'ENOENT' ? false : true; }
}

function atomicJson(file, value, io = fs) {
  const temporary = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
  try {
    io.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    io.renameSync(temporary, file);
  } catch (error) {
    try { io.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function normalizedTrigger(value) {
  // MasterControls writes UTC ISO milliseconds; PowerShell's round-trip format
  // uses seven fractional digits. Normalize both to JS precision, never making
  // a new campaign from cosmetic/sub-millisecond timestamp differences.
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  const normalized = new Date(time).toISOString();
  return normalized.slice(0, 19) === value.slice(0, 19) ? normalized : null;
}

function validateCampaign(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['triggeredAt', 'scopeFingerprint'].includes(key)) ||
      !normalizedTrigger(value.triggeredAt) || !/^[a-f0-9]{64}$/.test(value.scopeFingerprint || '')) throw evidenceError('CAMPAIGN_INVALID');
  return { triggeredAt: normalizedTrigger(value.triggeredAt), scopeFingerprint: value.scopeFingerprint };
}

function readCampaign(root, scope, io = fs) {
  let latch;
  try { latch = JSON.parse(io.readFileSync(path.join(root, 'emergency-latch.json'), 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw evidenceError('CAMPAIGN_INVALID'); }
  if (latch?.enabled !== true || !normalizedTrigger(latch.triggeredAt) || scope?.version !== 1 ||
      !Array.isArray(scope.projectIds) || !scope.projectIds.length ||
      scope.projectIds.some(id => typeof id !== 'string' || !ID_RE.test(id)) ||
      new Set(scope.projectIds.map(id => id.toLowerCase())).size !== scope.projectIds.length) throw evidenceError('CAMPAIGN_INVALID');
  return { triggeredAt: normalizedTrigger(latch.triggeredAt), scopeFingerprint: crypto.createHash('sha256')
    .update(JSON.stringify({ version: 1, projectIds: [...scope.projectIds].sort() })).digest('hex') };
}

function sameCampaign(left, right) {
  return !!left && !!right && left.triggeredAt === right.triggeredAt && left.scopeFingerprint === right.scopeFingerprint;
}

function validateAttempts(value) {
  if (!value || value.version !== 2 || Object.keys(value).some(key => !['version', 'campaign', 'attempts'].includes(key)) ||
      !value.attempts || typeof value.attempts !== 'object' || Array.isArray(value.attempts) ||
      Object.keys(value.attempts).length > 10000) throw Error('Stop-attempt ledger is invalid; no native stop submitted.');
  const campaign = validateCampaign(value.campaign);
  const result = Object.create(null);
  for (const [id, record] of Object.entries(value.attempts)) {
    if (!ID_RE.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id) ||
        !record || typeof record !== 'object' || Array.isArray(record) ||
        Object.keys(record).some(key => !['fingerprint', 'count', 'lastAttempt', 'inspectedAt'].includes(key)) ||
        !/^[a-f0-9]{64}$/.test(record.fingerprint || '') ||
        !Number.isInteger(record.count) || record.count < 0 || record.count > 3 ||
        !Number.isFinite(record.lastAttempt) || record.lastAttempt < 0 ||
        (Object.hasOwn(record, 'inspectedAt') && (!Number.isFinite(record.inspectedAt) || record.inspectedAt < 0))) {
      throw Error('Stop-attempt ledger is invalid; no native stop submitted.');
    }
    result[id] = { fingerprint: record.fingerprint, count: record.count, lastAttempt: record.lastAttempt,
      inspectedAt: record.inspectedAt ?? 0 };
  }
  return { campaign, attempts: result };
}

function readAttempts(root, campaign, io = fs) {
  const current = validateCampaign(campaign);
  try {
    const saved = validateAttempts(JSON.parse(io.readFileSync(path.join(root, ATTEMPTS_FILE), 'utf8').replace(/^\uFEFF/, '')));
    if (sameCampaign(saved.campaign, current)) return saved.attempts;
    // A new, later valid campaign may obtain a fresh bounded budget. Neither a
    // scope-only edit nor an old latch restored from backup can reset retries.
    if (Date.parse(current.triggeredAt) > Date.parse(saved.campaign.triggeredAt)) return Object.create(null);
    throw evidenceError('ATTEMPTS_INVALID');
  } catch (error) {
    if (error.code === 'ENOENT') return Object.create(null);
    throw evidenceError('ATTEMPTS_INVALID');
  }
}

function saveAttempts(root, attempts, campaign, io = fs) {
  const verified = validateAttempts({ version: 2, campaign, attempts });
  atomicJson(path.join(root, ATTEMPTS_FILE), { version: 2, ...verified }, io);
}

function projectSession(session) {
  // No prompts, terminal output, conversation bodies, or credentials are retained.
  const keys = ['id', 'projectId', 'kind', 'harness', 'mode', 'model', 'branch', 'createdAt',
    'updatedAt', 'terminalGeneration', 'isTerminated', 'status', 'statusReadiness',
    'provisionState', 'hibernatedAt', 'controllerState', 'controllerVerified'];
  const projected = {};
  for (const key of keys) {
    const value = session?.[key];
    if (Object.hasOwn(session || {}, key) && (value === null || ['string', 'boolean'].includes(typeof value))) projected[key] = value;
  }
  if (typeof session?.activity === 'string') projected.activity = session.activity;
  else if (typeof session?.activity?.state === 'string') projected.activity = { state: session.activity.state };
  return projected;
}

function parseTop(stdout) {
  let value;
  try { value = JSON.parse(String(stdout || '').replace(/^\uFEFF/, '')); }
  catch { throw Error('Native runtime counts are malformed.'); }
  if (!Array.isArray(value?.data)) throw Error('Native runtime counts are unavailable.');
  const counts = new Map();
  for (const row of value.data) {
    if (!row || typeof row.id !== 'string' || !ID_RE.test(row.id) || counts.has(row.id))
      throw Error('Native runtime inventory is ambiguous.');
    // In particular, null, absent, and string "0" are never coerced to zero.
    counts.set(row.id, Number.isSafeInteger(row.processCount) && row.processCount >= 0 ? row.processCount : null);
  }
  return counts;
}

function createRuntimeAdapters({ root = __dirname, scope, fetchImpl = globalThis.fetch,
  exec = execAsync, io = fs, now = Date.now, evidenceOptions = {},
  aoExecutable = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'agent-orchestrator', 'resources', 'daemon', 'ao.exe'),
  core = require('./fleet-codex-scope'), isLatched = () => latchEnabled(root, io) } = {}) {
  let lastFailure = null;
  const fail = code => { lastFailure = code; return evidenceError(code); };
  const inScope = session => session?.harness === 'codex' && scope?.projectIds?.includes(session.projectId) &&
    session.isTerminated === false && !!core.sessionIdentity(session);
  async function getJson(route, context) {
    try {
      const response = await fetchImpl(AO_URL + route, { signal: operationSignal(context, 2500), redirect: 'error' });
      if (!response?.ok) throw fail('AO_UNAVAILABLE');
      return await response.json();
    } catch { throw fail('AO_UNAVAILABLE'); }
  }
  async function readSessions(context) {
    const value = await getJson('/api/v1/sessions', context);
    if (!Array.isArray(value?.sessions) || value.sessions.length > 10000)
      throw fail('AO_INVENTORY_INVALID');
    const seen = new Set();
    const sessions = value.sessions.map(session => {
      if (typeof session?.id !== 'string' || !ID_RE.test(session.id) || seen.has(session.id))
        throw fail('AO_INVENTORY_INVALID');
      seen.add(session.id);
      return projectSession(session);
    });
    return sessions;
  }
  async function withControllerState(session, context) {
    if (!inScope(session) || session.mode !== 'chat') return session;
    // Query only this owned verification target, not every Chat session in
    // every inventory. Inspect the controller string and discard the payload.
    try {
      const value = await getJson('/api/v1/sessions/' + encodeURIComponent(session.id) + '/conversation?limit=1', context);
      const verified = typeof value?.controller === 'string';
      return { ...session, controllerVerified: verified, controllerState: verified ? value.controller : 'unknown' };
    } catch { return { ...session, controllerVerified: false, controllerState: 'unavailable' }; }
  }
  function checkExecutable() {
    if (!io.existsSync(aoExecutable)) throw fail('AO_NATIVE_UNAVAILABLE');
  }
  async function native(args, maxBuffer, context) {
    try {
      return await exec(aoExecutable, args, {
        windowsHide: true, shell: false, timeout: operationBudget(context, 12000),
        signal: context?.signal, maxBuffer, encoding: 'utf8'
      });
    } catch { throw fail('AO_NATIVE_UNAVAILABLE'); }
  }
  async function stopSession(session, context) {
    if (!inScope(session)) throw Error('Native stop target is not an explicit fleet-owned Codex session.');
    // Read-only HTTP must work immediately before invoking native AO. Never run
    // a CLI command against a known-offline daemon (some versions auto-start).
    const before = (await readSessions(context)).find(row => row.id === session.id);
    if (!inScope(before) || !core.sameIdentity(core.sessionIdentity(session), core.sessionIdentity(before)))
      throw Error('Native stop target changed before submission.');
    checkExecutable();
    if (isLatched() !== true) throw Error('Fleet latch was released before the native stop; no submission made.');
    await native(['session', 'exit-agent', session.id, '--project', session.projectId, '--json'], 262144, context);
    return { submitted: true }; // Submission is not a stopped-runtime receipt.
  }
  async function verifyStopped(session, context) {
    if (!inScope(session)) return false;
    let before = (await readSessions(context)).find(row => row.id === session.id);
    if (!inScope(before) || !core.sameIdentity(core.sessionIdentity(session), core.sessionIdentity(before))) return false;
    before = await withControllerState(before, context);
    const beforeState = before.activity?.state || before.activity || before.status;
    const beforeControllerStopped = before.mode === 'chat' && before.controllerVerified === true && before.controllerState === 'stopped';
    if (before.mode === 'chat' && !beforeControllerStopped) return false;
    // Do not run dozens of expensive process/probe commands before the first
    // bounded stop submission. Live activity is already a negative stop proof.
    if (['active', 'working', 'idle', 'waiting_input'].includes(beforeState) && !beforeControllerStopped) return false;
    checkExecutable();
    const result = await native(['session', 'top', '--all', '--project', session.projectId, '--json'], 8 * 1024 * 1024, context);
    const counts = parseTop(result.stdout);
    let after = (await readSessions(context)).find(row => row.id === session.id);
    if (!inScope(after) || !core.sameIdentity(core.sessionIdentity(before), core.sessionIdentity(after))) return false;
    after = await withControllerState(after, context);
    const state = after.activity?.state || after.activity || after.status;
    const controllerStopped = after.mode === 'chat' && after.controllerVerified === true && after.controllerState === 'stopped';
    if (after.mode === 'chat' && !controllerStopped) return false;
    if (counts.get(after.id) === 0 && (after.mode === 'chat' ? controllerStopped : ['exited', 'stopped'].includes(state))) return true;
    // Unknown counts stay unknown. Separate native proofs can establish provider
    // absence or an exited provider behind a still-live terminal host.
    const readCurrent = async () => Promise.all((await readSessions(context)).filter(row => row.id === session.id)
      .map(current => withControllerState(current, context)));
    const options = { ...evidenceOptions, root, now, aoExecutable, readSessions: readCurrent, signal: context?.signal };
    await attachWindowsStoppedEvidence(counts, [after], options);
    if (runtimeAbsentEvidence(after, counts, now())) return true;
    await attachExitedHostEvidence(counts, [after], options);
    return !!runtimeExitedHostEvidence(after, counts, now());
  }
  return { readSessions, stopSession, verifyStopped, lastFailure: () => lastFailure };
}

function baseStatus(root, watchdogPid, now, active) {
  return {
    active, phase: active ? 'partial_stop' : 'disarmed', scope: 'fleet-owned',
    checkedAt: new Date(now()).toISOString(), watchdogPid,
    remainingTotal: null, remaining: { codex: null }, remainingUnit: 'AO Codex sessions',
    orphanProcessesInspected: false, manualSessionsPreserved: true,
    dashboardPreserved: true, errorCount: 0, recentErrors: []
  };
}

async function runOnce({ root = __dirname, watchdogPid = process.ppid, dryRun = false,
  now = Date.now, io = fs, adapters = null, core = require('./fleet-codex-scope'),
  adapterOptions = {} } = {}) {
  const active = latchEnabled(root, io);
  let status = baseStatus(root, watchdogPid, now, active);
  let attempts, campaign;
  const campaignUnchanged = () => {
    try { return sameCampaign(campaign, readCampaign(root, core.readScope(root), io)); }
    catch { return false; }
  };
  try {
    if (!active) return status;
    const scope = core.readScope(root);
    campaign = readCampaign(root, scope, io);
    attempts = readAttempts(root, campaign, io); // Corrupt ledger never resets retry limits.
    const runtime = adapters || createRuntimeAdapters({ ...adapterOptions, root, scope, now, io, core, isLatched: campaignUnchanged });
    const result = await core.sweepFleetCodex({ scope, readSessions: runtime.readSessions,
      stopSession: async (session, context) => {
        if (dryRun) throw Error('Dry-run cannot submit native actions.');
        if (!campaignUnchanged()) throw evidenceError('CAMPAIGN_CHANGED');
        // Core records the intent synchronously before this callback. Persist it
        // BEFORE any native submission so a crash cannot create unbounded retries.
        saveAttempts(root, attempts, campaign, io);
        return runtime.stopSession(session, context);
      }, verifyStopped: runtime.verifyStopped, isLatched: campaignUnchanged,
      attempts, now, dryRun, maxStops: 4 });
    status = { ...status, ...result, active: latchEnabled(root, io), checkedAt: new Date(now()).toISOString(), watchdogPid };
    const failure = runtime.lastFailure?.();
    if (failure && status.phase === 'partial_stop' && FAILURE_MESSAGES[failure]) {
      status.errorCount = (status.errorCount || 0) + 1;
      status.recentErrors = [...(status.recentErrors || []), FAILURE_MESSAGES[failure]].slice(-5);
    }
    if (!status.active) status.phase = 'disarmed';
  } catch (error) {
    const stillActive = latchEnabled(root, io);
    status = { ...status, active: stillActive, phase: stillActive ? 'partial_stop' : 'disarmed', remainingTotal: null, remaining: { codex: null },
      errorCount: 1, recentErrors: [FAILURE_MESSAGES[error.code] || FAILURE_MESSAGES.SCOPED_EVIDENCE_UNAVAILABLE] };
  } finally {
    if (!dryRun) {
      status.active = latchEnabled(root, io);
      if (!status.active) status.phase = 'disarmed';
      if (attempts && status.active && campaignUnchanged()) {
        try { saveAttempts(root, attempts, campaign, io); }
        catch {
          status.phase = status.active ? 'partial_stop' : 'disarmed'; status.remainingTotal = null; status.remaining = { codex: null };
          status.errorCount = (status.errorCount || 0) + 1;
          status.recentErrors = [...(status.recentErrors || []), 'Stop-attempt ledger could not be persisted.'].slice(-5);
        }
      } else if (attempts && status.active) {
        status.phase = 'partial_stop'; status.remainingTotal = null; status.remaining = { codex: null };
        status.errorCount = (status.errorCount || 0) + 1;
        status.recentErrors = [...(status.recentErrors || []), FAILURE_MESSAGES.CAMPAIGN_CHANGED].slice(-5);
      }
      atomicJson(path.join(root, STATUS_FILE), status, io);
    }
  }
  return status;
}

function parseArguments(args) {
  let root, watchdogPid, dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root' && root === undefined) root = args[++i];
    else if (args[i] === '--watchdog-pid' && watchdogPid === undefined) watchdogPid = Number(args[++i]);
    else if (args[i] === '--dry-run' && !dryRun) dryRun = true;
    else throw Error('Unsupported watchdog argument.');
  }
  if (typeof root !== 'string' || !root || !path.isAbsolute(root) ||
      !Number.isSafeInteger(watchdogPid) || watchdogPid <= 0) throw Error('Exact root and watchdog PID are required.');
  return { root, watchdogPid, dryRun };
}

if (require.main === module) {
  let options;
  try { options = parseArguments(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
  if (options) runOnce(options).then(status => console.log(JSON.stringify({ ...status, dryRun: options.dryRun })))
    .catch(() => { console.error('Scoped watchdog status could not be persisted; fleet must remain latched.'); process.exitCode = 1; });
}

module.exports = { AO_URL, ATTEMPTS_FILE, STATUS_FILE, latchEnabled, atomicJson, normalizedTrigger,
  validateCampaign, readCampaign, sameCampaign, validateAttempts, readAttempts, saveAttempts,
  projectSession, parseTop, createRuntimeAdapters, baseStatus, runOnce, parseArguments };
