'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { DispatchLedger } = require('./vendor/mjobs/dispatch-ledger');
const { instruction } = require('./vendor/mjobs/find-work');
const { validateSelection } = require('./vendor/mjobs/provider-catalog');
const { PROJECT, SOURCE_REPO, ISSUE_REPO } = require('./config');
const { validateAgentInput } = require('./agent-provision');
const { ModelChanges } = require('./model-changes');
const { capacitySnapshot } = require('./capacity');
const { verifyReview } = require('./review-evidence');

function writeJSON(file, value) {
  const temp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}
function active(s) { return !s.isTerminated && !['exited', 'terminated', 'stopped'].includes(s.activity?.state || s.activity || s.status); }
function idle(s) { return (s.activity?.state || s.activity) === 'idle' && !s.isTerminated; }
function busy(s) { return active(s) && ['active', 'working'].includes(s.activity?.state || s.activity); }

class FleetController {
  constructor(config, { adapter, quota, providers = async () => ({ providers: [] }), agyUsage = async () => ({ fresh: false, remainingPercent: null }), nativeModel = null, reviewVerifier = verifyReview, now = Date.now, resources = () => ({ freeMemoryGiB: os.freemem() / 1073741824, totalMemoryGiB: os.totalmem() / 1073741824, cpuPercent: null, diskIO: null }) }) {
    if (config.projectId !== PROJECT || config.sourceRepository !== SOURCE_REPO || config.issueRepository !== ISSUE_REPO) throw Error('BabyTracker project identity is fixed');
    this.config = config; this.adapter = adapter; this.quotaReader = quota; this.providers = providers; this.agyReader = agyUsage; this.reviewVerifier = reviewVerifier; this.now = now; this.resources = resources;
    fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
    this.file = path.join(config.stateDir, 'controller.json');
    this.auditFile = path.join(config.stateDir, 'audit.jsonl');
    this.ledger = new DispatchLedger({ root: config.stateDir, now });
    try { this.state = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw Error('Controller state is unreadable; preserving it and refusing to start'); }
    if (!this.state) this.state = { schema: 1, projectId: PROJECT, sourceRepository: SOURCE_REPO, issueRepository: ISSUE_REPO, mode: 'paused', generation: 0, tasks: [], plans: {}, run: null, limits: { concurrency: 2, maxDispatches: 8, maxMinutes: 60, minimumRemainingPercent: 20, minimumFreeMemoryGiB: 4, maxAgents: 12 }, emergency: null };
    if (this.state.schema !== 1 || this.state.projectId !== PROJECT || this.state.sourceRepository !== SOURCE_REPO || this.state.issueRepository !== ISSUE_REPO || !Array.isArray(this.state.tasks)) throw Error('Controller state identity/schema mismatch');
    if (this.state.limits.maxAgents === undefined) this.state.limits.maxAgents = 12;
    this.modelChanges = new ModelChanges(this, nativeModel);
    this.modelChanges.afterRestart();
    // A dashboard restart never resumes paid work, uncertain deliveries, or old automation.
    if (this.state.mode !== 'emergency') this.state.mode = 'paused';
    this.state.generation++; this.state.run = null;
    this.state.recoveredAt = new Date(now()).toISOString();
    this.save(); this.audit('controller_started', { mode: this.state.mode });
    this.mutating = false; this.tickRunning = false; this.lastSnapshot = null; this.nextDispatchAt = null;
  }
  save() { writeJSON(this.file, this.state); }
  audit(event, details = {}) { fs.appendFileSync(this.auditFile, JSON.stringify({ at: new Date(this.now()).toISOString(), projectId: PROJECT, event, ...details }) + '\n', { mode: 0o600 }); }
  async sessions() {
    const all = await this.adapter.sessions();
    if (!Array.isArray(all)) throw Error('Invalid runtime sessions');
    return all.filter(s => s.projectId === PROJECT);
  }
  quota() { return this.quotaReader(); }
  quotaPolicy() {
    const q=this.quota(), configured=this.state.limits.minimumRemainingPercent;
    const sharedStop=Number.isInteger(q.sharedEmergencyGuard?.thresholdPercent)?q.sharedEmergencyGuard.thresholdPercent:null;
    const floor=Math.max(7,sharedStop??7), effective=Number.isInteger(configured)&&configured>=7&&configured<=99?Math.max(floor,configured):100;
    const fresh=q.fresh===true&&Number.isFinite(q.remainingPercent)&&q.remainingPercent>=0&&q.remainingPercent<=100;
    const blocked=!fresh||q.remainingPercent<=effective;
    return {configuredMinimumRemainingPercent:configured,minimumRemainingPercent:effective,minimumAllowedPercent:floor,remainingPercent:fresh?q.remainingPercent:null,fresh,blocked,
      sharedEmergencyGuard:q.sharedEmergencyGuard||null,
      reason:!fresh?(q.reason||'Fresh Codex quota is required')+'. New Codex work is blocked.':blocked?'QUOTA HOLD: '+q.remainingPercent+'% remaining; new Codex starts/tasks require more than '+effective+'% (configured threshold).':'Codex quota allows work: '+q.remainingPercent+'% remaining; required more than '+effective+'%.',
      note:sharedStop===null?'Shared emergency guard status unavailable. This project setting does not configure the machine-wide guard.':'Shared emergency stop: '+sharedStop+'% ('+(q.sharedEmergencyGuard.armed?'armed':'not armed')+'). This project setting does not change it.'};
  }
  async updateQuotaPolicy(value) {
    return this.serial(async()=>{
      if(['emergency','draining'].includes(this.state.mode))throw Error('Finish emergency/drain recovery before changing quota policy');
      const floor=this.quotaPolicy().minimumAllowedPercent;
      if(!Number.isInteger(value)||value<floor||value>99)throw Error('Start/new-work quota limit must be '+floor+' to 99%. Emergency protection cannot be bypassed.');
      this.state.limits.minimumRemainingPercent=value;this.save();this.audit('quota_policy_changed',{minimumRemainingPercent:value});
      return {ok:true,quotaPolicy:this.quotaPolicy(),note:'Quota limit saved at '+value+'%. Emergency guard and fleet running/paused state are unchanged.'};
    });
  }
  guard({ requireRunning = true, session = null, manualAgy = false } = {}) {
    if (this.state.mode === 'emergency') return 'BabyTracker emergency stop is latched';
    if (this.state.mode === 'draining') return 'BabyTracker is draining';
    if (requireRunning && this.state.mode !== 'running') return 'Fleet is paused';
    if (!this.config.runtimeVerified) return 'BabyTracker Orchestrator project/repository binding is not yet verified';
    if (this.resources().freeMemoryGiB < this.state.limits.minimumFreeMemoryGiB) return 'Below configured free-memory threshold';
    const run = this.state.run;
    if (requireRunning && !run) return 'No bounded run is active';
    if (requireRunning && run && (run.dispatches >= this.state.limits.maxDispatches || this.now() >= run.deadline)) return 'Configured run budget is exhausted';
    if (session?.harness === 'agy') {
      if (!manualAgy) return 'AGY has no verified automatic quota cutoff; confirm one manual turn instead';
      return null;
    }
    if (session && session.harness !== 'codex') return 'Unsupported provider';
    if (session?.harness === 'codex') {
      const policy=this.quotaPolicy();
      if(policy.blocked)return policy.reason;
    }
    return null;
  }
  async verifyAgyQuota() {
    let observation;
    try { observation = await this.agyReader(); }
    catch { observation = { fresh: false, remainingPercent: null, reason: 'AGY usage unavailable' }; }
    if (observation?.fresh && Number.isFinite(observation.remainingPercent) &&
        observation.remainingPercent <= this.state.limits.minimumRemainingPercent) {
      throw Error('Observed remaining AGY quota is at or below the configured threshold');
    }
    return observation;
  }
  capacity(sessions, online = true) {
    return capacitySnapshot({ sessions, entries: this.ledger.entries, limit: this.state.limits.concurrency,
      now: this.now(), cooldownMs: this.ledger.cooldownMs, online });
  }
  async updateConcurrency(value) {
    return this.serial(async () => {
      if (['emergency','draining'].includes(this.state.mode)) throw Error('Finish emergency/drain recovery before changing concurrency');
      if (!Number.isInteger(value) || value < 1 || value > 32) throw Error('Parallel-turn limit must be an integer from 1 to 32');
      const previous = this.state.limits.concurrency;
      this.state.limits.concurrency = value; this.save();
      this.audit('concurrency_limit_changed', { previous, concurrency: value });
      let sessions = [], online = true;
      try { sessions = await this.sessions(); } catch { online = false; }
      return { ok: true, capacity: this.capacity(sessions, online), note: 'Parallel-turn limit saved at ' + value + '. Existing turns were not stopped, new tasks were not sent, and quota protection was unchanged.' };
    });
  }
  dispatchAvailability(s, capacity) {
    if (!active(s)) return { canDispatch: false, code: 'inactive', reason: 'Agent is stopped or terminated' };
    if (busy(s)) return { canDispatch: false, code: 'busy', reason: 'This agent is already working; no duplicate turn will be sent' };
    const plan = this.state.plans[s.id];
    if (['queued','submitting','transitioning','unverified','reconcile_required','resume_required'].includes(plan?.status))
      return { canDispatch: false, code: 'model', reason: 'Model change ' + plan.status + ': complete or verify this handoff first' };
    const reservation = this.ledger.entries[s.id];
    if (reservation && ['reserved','uncertain'].includes(reservation.status))
      return { canDispatch: false, code: 'delivery', reason: 'A previous delivery is unresolved; inspect and reconcile it before resending' };
    const reason = this.guard({ session: s, manualAgy: s.harness === 'agy' });
    if (reason) return { canDispatch: false, code: 'guard', reason };
    const task = this.state.tasks.find(t => t.agentId === s.id && t.status === 'queued');
    if (task?.dependencies?.some(id => !this.state.tasks.some(t => t.id === id && t.status === 'accepted')))
      return { canDispatch: false, code: 'dependency', reason: 'Task is waiting on an accepted dependency' };
    if (reservation && this.now() - reservation.at < this.ledger.cooldownMs)
      return { canDispatch: false, code: 'cooldown', reason: 'A recent submission is still in its duplicate-send cooldown' };
    if (!capacity.online || capacity.full) return { canDispatch: false, code: 'capacity', reason: capacity.reason };
    if (!idle(s)) return { canDispatch: false, code: 'runtime', reason: 'Agent is not idle; inspect the native agent for pending input' };
    return { canDispatch: true, code: 'ready', reason: s.harness === 'agy' ? 'Manual dispatch only; separate Google quota confirmation required' : 'Ready for one bounded dispatch', requiresConfirmation: s.harness === 'agy' };
  }
  async snapshot() {
    let sessions = [], runtime = { online: true, reason: null };
    try { sessions = await this.sessions(); } catch (e) { runtime = { online: false, reason: e.message }; }
    const now = this.now();
    const capacity = this.capacity(sessions, runtime.online);
    const rows = sessions.map(s => {
      const task = this.state.tasks.find(t => t.agentId === s.id && !['accepted', 'cancelled'].includes(t.status));
      const reservation = this.ledger.entries[s.id];
      const ambiguous = reservation && ['reserved', 'uncertain'].includes(reservation.status);
      const cooldown = reservation && !ambiguous ? Math.max(0, reservation.at + this.ledger.cooldownMs - now) : 0;
      const eligibility = this.dispatchAvailability(s, capacity);
      let label = 'Blocked';
      if (busy(s)) label = /review/i.test(s.displayName || '') ? 'Reviewing' : 'Actively Working';
      else if (!active(s)) label = 'Paused';
      else if (ambiguous) label = 'Blocked';
      else if (this.state.mode !== 'running') label = 'Paused';
      else if (task?.dependencies?.some(id => !this.state.tasks.some(t => t.id === id && t.status === 'accepted'))) label = 'Waiting on Dependency';
      else if (cooldown > 0) label = 'Cooldown';
      else if (idle(s)) label = 'Available for Dispatch';
      if (!busy(s) && ['queued','submitting','transitioning','unverified','reconcile_required','resume_required'].includes(this.state.plans[s.id]?.status))
        label = this.state.plans[s.id].status === 'transitioning' ? 'Switching model' : 'Model change ' + this.state.plans[s.id].status.replace(/_/g, ' ');
      if (idle(s) && this.state.mode === 'running' && !eligibility.canDispatch) {
        if (eligibility.code === 'capacity') label = 'Waiting for slot';
        else if (eligibility.code === 'guard') label = 'Blocked by policy';
      }
      return { ...eligibility, id: s.id, projectId: PROJECT, name: s.displayName || s.id, kind: s.kind || 'worker', mode: s.mode || 'unknown', runtimeActive:active(s), harness: s.harness || 'unknown', model: s.model || 'unknown', effort: s.effort || null, label, busy: busy(s), idle: idle(s), taskId: task?.id || null, issue: task?.issue || null, prs: (s.prs || []).map(p => ({ number: p.number, state: p.state, ci: p.ci, url: typeof p.url === 'string' && p.url.startsWith('https://github.com/' + SOURCE_REPO + '/') ? p.url : null })), cooldownSeconds: Math.ceil(cooldown / 1000), dispatchEta: cooldown > 0 ? new Date(now + cooldown).toISOString() : null, unresolvedDelivery: !!ambiguous, tokens: null, turnStatistics: null, lastActivity: s.activity?.lastActivityAt || s.activity?.timestamp || null };
    });
    const agyUsage = await this.agyReader().catch(() => ({ fresh: false, remainingPercent: null, reason: 'AGY usage unavailable' }));
    const result = { observedAt: new Date(now).toISOString(), capacity, agyUsage, provisioning: this.state.provisioning || null, bootstrap: this.state.bootstrap ? { status: this.state.bootstrap.status } : null, projectId: PROJECT, sourceRepository: SOURCE_REPO, issueRepository: ISSUE_REPO, mode: this.state.mode, runtime, sessions: rows, tasks: this.state.tasks, plans: this.state.plans, limits: this.state.limits, run: this.state.run, quota: this.quota(), quotaPolicy:this.quotaPolicy(), resources: this.resources(), dispatchBlocker: this.guard(), codexDispatchBlocker: this.guard({ session: { harness: 'codex' } }), emergency: this.state.emergency, summary: { total: rows.length, working: rows.filter(x => x.busy).length, available: rows.filter(x => x.canDispatch).length, blocked: rows.filter(x => x.runtimeActive && !x.busy && !x.canDispatch).length }, acceptance: { status: 'NOT_ASSESSED', percent: null, note: 'Task completion is separate from requirement acceptance; verified review receipts are recorded per task.' }, capabilities: { scopedControl: true, persistentQueue: true, boundedDispatch: true, independentReviewGate: true, reviewAssessment: true, modelPlans: true, modelReplacement: false, nativeChatNextTurnModel: !!this.modelChanges.native, nativeTuiProviderHandoff: !!this.modelChanges.native, queuedGracefulModelChange: !!this.modelChanges.native, sameHarnessTuiModelChange: false, firstCodexBootstrap: typeof this.adapter.provisionCodex === 'function', explicitAgentProvisioning: typeof this.adapter.provisionSelection === 'function', dynamicProvisioning: true, automaticWorkerScaling: false, geminiBudget: false, diskIO: false, perAgentTokens: false } };
    this.lastSnapshot = result; return result;
  }
  async serial(fn) {
    if (this.mutating) throw Error('Another controller action is running; refresh before trying again');
    this.mutating = true;
    try { return await fn(); } finally { this.mutating = false; }
  }
  async reconcileBootstrap(confirm) {
    return this.serial(async () => {
      if (confirm !== 'RECONCILE BOOTSTRAP') throw Error('Exact bootstrap reconciliation confirmation required');
      if (this.state.mode !== 'paused' || this.state.bootstrap?.status !== 'uncertain') throw Error('No paused uncertain bootstrap to reconcile');
      const size = fs.statSync(this.auditFile).size;
      if (size > 5_000_000) throw Error('Bootstrap audit is too large for automatic verification');
      const events = fs.readFileSync(this.auditFile, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
      const submitted = events.filter(event => event.event === 'codex_bootstrap_submitting').at(-1);
      const failed = events.filter(event => event.event === 'codex_bootstrap_unverified').at(-1);
      const submittedAt = Date.parse(submitted?.at), failedAt = Date.parse(failed?.at);
      if (!Number.isFinite(submittedAt) || !Number.isFinite(failedAt) || failedAt < submittedAt ||
          Math.abs(failedAt - Date.parse(this.state.bootstrap.at)) > 1000 || this.now() - submittedAt < 30_000) {
        throw Error('Bootstrap audit timing cannot establish a safe reconciliation window');
      }
      const inspect = async () => {
        const sessions = await this.sessions();
        if (sessions.some(s => !Number.isFinite(Date.parse(s.createdAt)) || Date.parse(s.createdAt) >= submittedAt)) {
          throw Error('A BabyTracker session appeared during or after uncertain bootstrap');
        }
        if (sessions.some(active)) throw Error('A BabyTracker session is still active');
        return sessions.map(s => s.id).sort();
      };
      const first = await inspect();
      await new Promise(resolve => setTimeout(resolve, 500));
      const second = await inspect();
      if (JSON.stringify(first) !== JSON.stringify(second)) throw Error('BabyTracker session roster changed during reconciliation');
      this.state.bootstrap = { status: 'reconciled_no_new_session', at: new Date(this.now()).toISOString(), submittedAt: submitted.at };
      this.save(); this.audit('codex_bootstrap_reconciled_no_session', { submittedAt: submitted.at, sessionCount: second.length });
      return { ok: true, note: 'Two live AO reads found no new or active BabyTracker session. Dispatch remains paused.' };
    });
  }
  async start() {
    return this.serial(async () => {
      if (this.state.mode === 'running') throw Error('Pause before explicitly starting a new bounded run');
      if (this.state.mode === 'draining') throw Error('Graceful shutdown is still in progress; wait for it to finish');
      const blocker = this.guard({ requireRunning: false }); if (blocker) throw Error(blocker);
      // A persistent pending/uncertain bootstrap must be reconciled before any
      // new CLI spawn. A failed/slow response may already have created a worker.
      if (Object.values(this.ledger.entries).some(r => ['reserved', 'uncertain'].includes(r.status))) throw Error('Unresolved delivery requires manual reconciliation before startup');
      const generation = this.state.generation;
      let sessions = await this.sessions();
      // AGY-only fleets are not blocked by a separate Codex quota window.
      if (!sessions.some(s => active(s) && s.harness === 'agy')) {
        const codexGate = this.guard({ requireRunning: false, session: { harness: 'codex' } });
        if (codexGate) throw Error(codexGate);
      }
      let createdSessionId = null;
      if (!sessions.some(active)) {
        if (['pending', 'uncertain'].includes(this.state.bootstrap?.status)) throw Error('An earlier Codex bootstrap has unverified delivery. Inspect AO sessions before retrying.');
        if (typeof this.adapter.provisionCodex !== 'function') throw Error('No verified BabyTracker Codex session exists; provisioning adapter is unavailable.');
        let provisioned;
        try {
          provisioned = await this.adapter.provisionCodex(() => {
            if (generation !== this.state.generation || this.state.mode === 'emergency') throw Error('Start was interrupted before provisioning');
            this.state.bootstrap = { status: 'pending', startedAt: new Date(this.now()).toISOString() };
            this.save(); this.audit('codex_bootstrap_submitting');
          });
          if (!provisioned || typeof provisioned.id !== 'string') throw Error('Provisioner returned no session identity');
          createdSessionId = provisioned.created ? provisioned.id : null;
          this.state.bootstrap = { status: 'verified', sessionId: provisioned.id, verifiedAt: new Date(this.now()).toISOString() };
          this.save(); this.audit('codex_bootstrap_verified', { sessionId: provisioned.id, created: !!provisioned.created });
          sessions = await this.sessions();
          if (generation === this.state.generation && this.state.mode !== 'emergency' && !sessions.some(s => s.id === provisioned.id && active(s) && s.harness === 'codex')) {
            throw Error('The provisioned BabyTracker session is no longer live');
          }
        } catch (error) {
          if (this.state.bootstrap?.status === 'pending' || (this.state.bootstrap?.status === 'verified' && createdSessionId)) {
            this.state.bootstrap = { status: 'uncertain', at: new Date(this.now()).toISOString() };
            this.save(); this.audit('codex_bootstrap_unverified', { reason: String(error.message).slice(0, 180) });
            throw Error('Codex bootstrap delivery is unverified. Inspect AO sessions before retrying: ' + error.message);
          }
          throw error;
        }
      }
      if (generation !== this.state.generation || this.state.mode === 'emergency') {
        if (this.state.mode === 'emergency' && createdSessionId && sessions.some(s => s.id === createdSessionId && active(s))) {
          try { await this.adapter.command('kill', createdSessionId); }
          catch (error) {
            if (this.state.emergency) { this.state.emergency.phase = 'unverified'; this.save(); }
            this.audit('codex_bootstrap_emergency_exit_unverified', { reason: String(error.message).slice(0, 180) });
          }
        }
        throw Error('Start superseded by a stop; dispatch remains disabled');
      }
      const freshBlocker = this.guard({ requireRunning: false }); if (freshBlocker) throw Error(freshBlocker);
      this.state.mode = 'running'; this.state.generation++;
      this.state.run = { id: randomUUID(), startedAt: new Date(this.now()).toISOString(), deadline: this.now() + this.state.limits.maxMinutes * 60000, dispatches: 0, turbo: false };
      this.save(); this.audit('fleet_started', { runId: this.state.run.id });
      return { ok: true, note: createdSessionId ? 'One verified BabyTracker Codex orchestrator was created. Bounded dispatch is enabled; no task was automatically sent.' : 'Bounded dispatch enabled using an existing BabyTracker Codex session. No task was sent by Start Fleet.' };
    });
  }
  pause(reason = 'User paused dispatch') {
    if (this.state.mode === 'emergency') return { ok: true, note: 'Emergency stop stays latched; its shutdown verification continues.' };
    if (this.state.mode !== 'emergency') this.state.mode = 'paused';
    this.state.generation++; if (this.state.run) this.state.run.turbo = false;
    this.nextDispatchAt = null; this.save(); this.audit('fleet_paused', { reason });
    return { ok: true, note: 'New assignments paused; active turns were preserved.' };
  }
  async stop(emergency) {
    if (!emergency && this.state.mode === 'emergency') return { ok: true, note: 'Emergency stop stays latched. Verify shutdown and explicitly release it before other lifecycle changes.' };
    if (!emergency && this.state.mode === 'draining') return { ok: true, note: 'Graceful shutdown is already in progress.' };
    // Stop fencing happens synchronously before any awaited network operation.
    this.state.mode = emergency ? 'emergency' : 'draining'; this.state.generation++;
    const generation = this.state.generation;
    if (this.state.run) this.state.run.turbo = false;
    if (emergency) this.state.emergency = { at: new Date(this.now()).toISOString(), phase: 'requested', remaining: null, results: [] };
    this.save(); this.audit(emergency ? 'emergency_latched' : 'graceful_stop_requested');
    let sessions;
    try { sessions = await this.sessions(); }
    catch (e) {
      if (emergency && generation === this.state.generation) { this.state.emergency.phase = 'unverified'; this.state.emergency.reason = e.message; this.save(); }
      return { ok: false, note: 'Dispatch is stopped; runtime termination could not be verified.', error: e.message };
    }
    const results = [];
    for (const s of sessions.filter(active)) {
      if (generation !== this.state.generation) return { ok: false, note: 'A newer lifecycle action superseded this stop request.' };
      try {
        const action = emergency ? 'kill' : idle(s) ? 'exit' : 'send';
        await this.adapter.command(action, s.id, 'GRACEFUL WIND-DOWN ORDER FROM USER: stop delegating new work, finish or checkpoint your current BabyTracker task, preserve branches and uncommitted files, then exit. Do not restart until explicitly requested.', () => { if (generation !== this.state.generation) throw Error('A newer lifecycle action superseded this stop request'); });
        results.push({ id: s.id, action, status: 'submitted' });
      } catch (e) { results.push({ id: s.id, status: 'unverified', error: e.message }); }
    }
    if (emergency) {
      let remaining = null;
      try { remaining = (await this.sessions()).filter(active).length; } catch {}
      if (generation !== this.state.generation) return { ok: false, note: 'A newer lifecycle action superseded this stop request.' };
      this.state.emergency = { ...this.state.emergency, phase: remaining === 0 ? 'verified_stopped' : 'unverified', remaining, results }; this.save();
    }
    this.audit(emergency ? 'emergency_results' : 'graceful_results', { results });
    return { ok: results.every(r => r.status === 'submitted'), results, note: 'Only verified BabyTracker sessions were targeted. Submission is not proof of process exit.' };
  }
  async releaseEmergency() {
    if (this.state.mode !== 'emergency') throw Error('No emergency stop is latched');
    const generation = this.state.generation;
    const sessions = await this.sessions();
    if (generation !== this.state.generation) throw Error('Emergency state changed; no release performed');
    if (sessions.some(active)) throw Error('BabyTracker runtime shutdown is not yet verified');
    this.state.mode = 'paused'; this.state.generation++; this.state.emergency = null; this.save();
    this.audit('emergency_released'); return { ok: true, note: 'Emergency latch released; dispatch stays paused.' };
  }
  limits(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Limits object required');
    const ranges = { concurrency: [1, 32], maxDispatches: [1, 1000], maxMinutes: [1, 720], minimumRemainingPercent: [7, 99], minimumFreeMemoryGiB: [1, 128], maxAgents: [1, 64] };
    for (const [key, value] of Object.entries(input)) if (!ranges[key] || !Number.isInteger(value) || value < ranges[key][0] || value > ranges[key][1]) throw Error('Invalid limit: ' + key);
    if(input.minimumRemainingPercent!==undefined&&input.minimumRemainingPercent<this.quotaPolicy().minimumAllowedPercent)throw Error('Quota limit cannot be below shared emergency protection');
    if (this.state.mode === 'running') throw Error('Pause before changing a run budget');
    this.state.limits = { ...this.state.limits, ...input }; this.save(); this.audit('limits_changed', input); return this.state.limits;
  }
  enqueue(input) {
    if (!input || typeof input.title !== 'string' || input.title.trim().length < 5 || input.title.length > 200 || !Number.isSafeInteger(input.issue) || input.issue < 1) throw Error('Task needs a title and existing positive issue number');
    if (this.state.tasks.some(t => t.issue === input.issue && !['accepted', 'cancelled'].includes(t.status))) throw Error('This issue already has an unfinished task');
    if (!Array.isArray(input.files) || !input.files.length || input.files.length > 100 || input.files.some(f => typeof f !== 'string' || !f || f.length > 200 || f.includes('..') || /[\\*?\x00-\x1f]/.test(f) || f.startsWith('/') || /^[A-Za-z]:/.test(f))) throw Error('Task requires bounded repository-relative file scopes');
    const dependencies = input.dependencies || [];
    if (!Array.isArray(dependencies) || dependencies.some(id => !this.state.tasks.some(t => t.id === id))) throw Error('Unknown dependency');
    const files = [...new Set(input.files.map(f => path.posix.normalize(f).replace(/\/$/, '')))];
    if (files.some(f => !f || f === '.')) throw Error('A repository-wide file claim is not a bounded task scope');
    const task = { id: randomUUID(), title: input.title.trim(), issue: input.issue, priority: ['P0', 'P1', 'P2'].includes(input.priority) ? input.priority : 'P1', files, dependencies, status: 'proposed', agentId: null, createdAt: new Date(this.now()).toISOString(), acceptance: 'NOT_ASSESSED' };
    this.state.tasks.push(task); this.save(); this.audit('task_proposed', { id: task.id, issue: task.issue }); return task;
  }
  async addAgent(input) {
    return this.serial(async () => {
      const blocker = this.guard({ requireRunning: false }); if (blocker) throw Error(blocker);
      if (['pending', 'uncertain'].includes(this.state.provisioning?.status)) throw Error('An earlier native spawn needs reconciliation before another');
      if (typeof this.adapter.provisionSelection !== 'function') throw Error('AO agent creation is unavailable');
      const selection = validateAgentInput(input, await this.providers());
      if (selection.harness === 'codex') {
        const codexGate = this.guard({ requireRunning: false, session: { harness: 'codex' } });
        if (codexGate) throw Error(codexGate);
      } else {
        if (input.acknowledgeUnknownAgyQuota !== true) throw Error('Acknowledge that AGY quota has no verified automatic cutoff');
        await this.verifyAgyQuota();
      }
      const sessions = await this.sessions(), live = sessions.filter(active);
      if (live.length >= this.state.limits.maxAgents) throw Error('Maximum project agent count reached; adjust the limit while paused');
      if (selection.kind === 'orchestrator' && live.some(s => s.kind === 'orchestrator')) throw Error('The BabyTracker orchestrator already exists; add workers instead');
      const generation = this.state.generation;
      let spawned, submitted = false;
      try {
        spawned = await this.adapter.provisionSelection(selection, record => {
          if (generation !== this.state.generation || ['emergency', 'draining'].includes(this.state.mode)) throw Error('Provisioning stopped before native spawn');
          submitted = true;
          this.state.provisioning = { status: 'pending', at: new Date(this.now()).toISOString(), selection: {
            name: selection.name, harness: selection.harness, kind: selection.kind, model: selection.model
          }, previousIds: record.existingIds };
          this.save(); this.audit('agent_spawn_submitting', { harness: selection.harness, name: selection.name });
        });
        if (!spawned || typeof spawned.id !== 'string') throw Error('AO session identity unavailable after spawn');
        if (generation !== this.state.generation && ['emergency','draining'].includes(this.state.mode)) {
          try { await this.adapter.command('kill', spawned.id); }
          catch (error) {
            if (this.state.emergency) { this.state.emergency.phase = 'unverified'; this.save(); }
            this.audit('late_spawn_shutdown_unverified', { id: spawned.id });
          }
          throw Error('Spawn raced a stop; inspect the BabyTracker session');
        }
        this.state.provisioning = { status: 'verified', id: spawned.id, at: new Date(this.now()).toISOString(),
          selection: { name: selection.name, harness: selection.harness, kind: selection.kind, model: selection.model } };
        this.save(); this.audit('agent_spawn_verified', { id: spawned.id, harness: selection.harness, model: selection.model });
        return { ok: true, sessionId: spawned.id, note: selection.harness === 'agy'
          ? 'Verified AGY agent created. No task sent. Google quota cutoff is unverified: manual dispatch only.'
          : 'Verified Codex agent created. No prompt or task sent.' };
      } catch (error) {
        if (submitted && this.state.provisioning?.status === 'pending') {
          this.state.provisioning.status = 'uncertain'; this.state.provisioning.reason = String(error.message).slice(0, 180);
          this.save(); this.audit('agent_spawn_uncertain', { harness: selection.harness });
          throw Error('Native spawn delivery is unverified; reconcile before retrying. ' + error.message);
        }
        throw error;
      }
    });
  }
  async reconcileAgentSpawn({ confirmNoSession = false } = {}) {
    return this.serial(async () => {
      const pending = this.state.provisioning;
      if (!pending || !['pending', 'uncertain'].includes(pending.status)) throw Error('No uncertain spawn to reconcile');
      const originalIds = new Set(pending.previousIds || []);
      const findNew = sessions => sessions.filter(s => !originalIds.has(s.id) && s.projectId === PROJECT);
      const first = findNew(await this.sessions());
      if (first.length === 1 && active(first[0]) && first[0].harness === pending.selection?.harness &&
          first[0].kind === pending.selection?.kind && first[0].displayName === pending.selection?.name) {
        pending.status = 'verified'; pending.id = first[0].id; delete pending.previousIds; delete pending.reason;
        pending.at = new Date(this.now()).toISOString(); this.save(); this.audit('agent_spawn_reconciled', { id: first[0].id });
        return { ok: true, sessionId: first[0].id, note: 'Verified an existing BabyTracker agent without creating a duplicate.' };
      }
      if (first.length || !confirmNoSession) throw Error('A new project session was not verified; no retry performed. Inspect AO and use explicit no-session reconciliation if native spawn failed.');
      const ageMs = this.now() - Date.parse(pending.at);
      if (!Number.isFinite(ageMs) || ageMs < 30000) throw Error('Wait at least 30 seconds before reconciling a rejected native spawn');
      await new Promise(resolve => setTimeout(resolve, 400));
      const second = findNew(await this.sessions());
      if (second.length) throw Error('New BabyTracker session appeared during reconciliation. Inspect its ownership before retrying.');
      pending.status = 'rejected'; pending.rejectedAt = new Date(this.now()).toISOString();
      pending.reason = 'Explicit failed native spawn; two AO reads confirmed no new BabyTracker session';
      delete pending.previousIds; this.save();
      this.audit('agent_spawn_no_session_confirmed', { name: pending.selection?.name, harness: pending.selection?.harness });
      return { ok: true, note: 'No BabyTracker agent was created. The previous rejected spawn is recorded and cleared; you may now retry with a supported provider mode.' };
    });
  }
  async assign(taskId, agentId) {
    return this.serial(async () => {
      const task = this.state.tasks.find(t => t.id === taskId); if (!task || !['proposed', 'queued'].includes(task.status)) throw Error('Only a proposed/queued task can be assigned');
      const sessions = await this.sessions(); const s = sessions.find(x => x.id === agentId);
      if (!s || !idle(s)) throw Error('Assignment requires an idle BabyTracker session');
      if (this.state.tasks.some(t => t.id !== task.id && t.agentId === agentId && !['accepted', 'cancelled'].includes(t.status))) throw Error('Agent already owns an unfinished task');
      if (['queued','submitting','transitioning','unverified','reconcile_required','resume_required'].includes(this.state.plans[agentId]?.status)) throw Error('This agent has a pending model change and cannot take a new assignment');
      if (this.state.tasks.some(t => t.id !== task.id && t.agentId && !['accepted', 'cancelled'].includes(t.status) && t.files.some(f => task.files.some(g => f === g || f.startsWith(g + '/') || g.startsWith(f + '/'))))) throw Error('File ownership overlaps another unfinished task');
      task.agentId = agentId; task.status = 'queued'; this.save(); this.audit('task_assigned', { taskId, agentId }); return task;
    });
  }
  async assessTask(taskId, request) {
    return this.serial(async () => {
      if (request?.confirm !== 'ASSESS BabyTracker') throw Error('Exact assessment confirmation required');
      const task = this.state.tasks.find(t => t.id === taskId);
      if (!task || task.status !== 'submitted' || task.acceptance === 'ACCEPTED') throw Error('Only a submitted BabyTracker task can be assessed');
      const prior = Array.isArray(task.reviewReceipts) ? task.reviewReceipts : [];
      if (prior.length >= 3) throw Error('Review revision limit reached');
      if (prior.length === 2 && request.decision === 'revision_requested') throw Error('Final review must accept or reject');
      const generation = this.state.generation;
      const receipt = await this.reviewVerifier(task, request);
      if (generation !== this.state.generation || task.status !== 'submitted') throw Error('Task or fleet changed during review verification');
      if (!receipt || receipt.decision !== request.decision || receipt.repository !== SOURCE_REPO || !/^[a-f0-9]{40}$/.test(receipt.headSha||'') ||
          !Number.isSafeInteger(receipt.reviewId) || !Number.isSafeInteger(receipt.prNumber) ||
          typeof receipt.reviewer !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(receipt.reviewer) || !Number.isFinite(Date.parse(receipt.reviewedAt)) ||
          prior.some(r => r.headSha === receipt.headSha || r.reviewId === receipt.reviewId)) throw Error('Review receipt is invalid or repeated');
      task.reviewReceipts = [...prior, { ...receipt, assessedAt: new Date(this.now()).toISOString() }];
      task.acceptance = request.decision.toUpperCase();
      task.status = request.decision === 'accepted' ? 'accepted' : request.decision === 'rejected' ? 'rejected' : 'proposed';
      if (request.decision === 'revision_requested') task.agentId = null;
      this.save(); this.audit('task_assessed', { taskId, decision: request.decision, reviewId: receipt.reviewId, prNumber: receipt.prNumber });
      return { ok: true, taskId, decision: request.decision, reviewRevision: task.reviewReceipts.length, note: 'Independent review receipt recorded. No work was dispatched.' };
    });
  }
  async dispatch(id, kind = 'find-work', { manualAgy = false } = {}) {
    return this.serial(async () => {
      const generation = this.state.generation;
      let blocker = this.guard(); if (blocker) throw Error(blocker);
      const sessions = await this.sessions(), s = sessions.find(x => x.id === id);
      if (!s || !idle(s)) throw Error('Only an idle BabyTracker agent can receive a new bounded instruction');
      if (['queued','submitting','transitioning','unverified','reconcile_required','resume_required'].includes(this.state.plans[id]?.status)) throw Error('A model handoff is queued or unverified for this agent; no new work can be assigned until it completes');
      blocker = this.guard({ session: s, manualAgy }); if (blocker) throw Error(blocker);
      if (s.harness === 'agy') await this.verifyAgyQuota();
      const capacity = this.capacity(sessions);
      if (capacity.full) throw Error(capacity.reason);
      const primary = sessions.find(x => x.kind === 'orchestrator' && active(x))?.id || 'the BabyTracker integration owner';
      const task = this.state.tasks.find(t => t.agentId === id && t.status === 'queued');
      if (task?.dependencies.some(dep => !this.state.tasks.some(t => t.id === dep && t.status === 'accepted'))) throw Error('Task is waiting on an accepted dependency');
      const prefix = 'PROJECT BOUNDARY: BabyTracker ONLY. Source repo ' + SOURCE_REPO + '; requirement issues ' + ISSUE_REPO + '. Preserve production infant data. Never touch MJobs queues, worktrees, services, budgets, credentials, or global process controls. Use synthetic test data. No live deployment, unreviewed merge, or paid service activation. ';
      const message = prefix + (kind === 'nudge'
        ? 'Report only your current issue, progress, PR/CI blocker and next bounded action. Do not start unrelated work.'
        : task
          ? 'Assigned requirement ' + ISSUE_REPO + '#' + task.issue + ': ' + task.title + '. Exclusive file scope: ' + task.files.join(', ') + '. Read and verify the issue acceptance criteria before changing code. Implement a bounded slice and provide tests and independent-review evidence; do not mark acceptance complete yourself.'
          : instruction({ ...s, isIdle: true }, primary).message);
      if (generation !== this.state.generation) throw Error('Dispatch superseded by a stop');
      const reserved = this.ledger.reserve(id, message);
      this.state.run.dispatches++; if (task && kind !== 'nudge') task.status = 'dispatching'; this.save();
      try {
        await this.adapter.command('send', id, message, current => {
          if (generation !== this.state.generation) throw Error('Dispatch superseded by a stop');
          if (current && (current.projectId !== PROJECT || !idle(current) || current.harness !== s.harness)) throw Error('Current runtime identity/activity changed before submission');
          const reason = this.guard({ session: s, manualAgy });
          // This reservation already consumes one dispatch; allow exactly the final unit.
          if (reason && !(reason === 'Configured run budget is exhausted' && this.state.run?.dispatches === this.state.limits.maxDispatches && this.now() < this.state.run.deadline)) throw Error(reason);
        });
        this.ledger.finish(id, reserved.id, 'submitted'); if (task && kind !== 'nudge') task.status = 'submitted'; this.save();
        this.audit('dispatch_submitted', { sessionId: id, taskId: task?.id || null, kind });
        return { ok: true, status: 'submitted', note: 'Instruction submitted; completion must be independently verified.' };
      } catch (e) {
        this.ledger.finish(id, reserved.id, 'uncertain'); if (task && kind !== 'nudge') task.status = 'reconciliation_required'; this.save();
        this.audit('dispatch_uncertain', { sessionId: id });
        throw Error('Delivery is unverified and will not be automatically retried: ' + e.message);
      }
    });
  }
  async allHands() {
    const sessions = await this.sessions(); const results = [];
    const capacity = this.capacity(sessions);
    if (capacity.full) return { ok: true, results, capacity, note: capacity.reason };
    for (const s of sessions.filter(s => idle(s) && s.harness === 'codex' && !['queued','submitting','transitioning','unverified','reconcile_required','resume_required'].includes(this.state.plans[s.id]?.status))) {
      if (this.guard()) break;
      try { results.push({ id: s.id, ...(await this.dispatch(s.id)) }); }
      catch (e) { results.push({ id: s.id, ok: false, error: e.message }); }
      // Count submitted turns too: the daemon may not yet reflect their activity.
      if (results.filter(r => r.ok).length >= this.state.limits.concurrency) break;
    }
    return { results, note: 'One bounded Codex-only pass. AGY is excluded from automatic All Hands because its quota cutoff is not verified.' };
  }
  occupiedSlots(sessions) { return new Set(this.capacity(sessions).slots.map(s => s.id)); }
  async changeModel(id, input) { return this.serial(() => this.modelChanges.request(id, input)); }
  async cancelModelChange(id) { return this.serial(() => this.modelChanges.cancel(id)); }
  async reconcileModelChange(id) { return this.serial(() => this.modelChanges.reconcile(id)); }
  async resumeModelChange(id) { return this.serial(() => this.modelChanges.resume(id)); }
  async savePlan(id, input) {
    const sessions = await this.sessions(); if (!sessions.some(s => s.id === id && !s.isTerminated)) throw Error('Unknown BabyTracker session');
    const selection = validateSelection(input, await this.providers());
    this.state.plans[id] = { ...selection, status: 'staged', at: new Date(this.now()).toISOString() }; this.save();
    this.audit('model_plan_staged', { id, harness: selection.harness, model: selection.model });
    return { ok: true, note: 'Plan staged. Running agent and model have NOT changed. Use Add Agent for an applied model on a new session.' };
  }
  turbo(enabled) {
    if (typeof enabled !== 'boolean') throw Error('Turbo state must be boolean');
    const blocker = this.guard(); if (enabled && blocker) throw Error(blocker);
    if (!this.state.run) throw Error('Start a bounded run before enabling Turbo');
    this.state.run.turbo = enabled; this.nextDispatchAt = enabled ? this.now() : null; this.save();
    this.audit('turbo_changed', { enabled }); return { enabled };
  }
  async tick() {
    if (this.tickRunning) return;
    this.tickRunning = true;
    try {
      if (this.state.mode === 'draining') {
        const generation = this.state.generation;
        const sessions = await this.sessions();
        if (this.state.mode !== 'draining' || generation !== this.state.generation) return;
        for (const s of sessions.filter(idle)) {
          await this.adapter.command('exit', s.id, undefined, () => { if (this.state.mode !== 'draining' || generation !== this.state.generation) throw Error('Graceful shutdown superseded'); });
        }
        if (this.state.mode === 'draining' && generation === this.state.generation && !sessions.some(active)) { this.state.mode = 'paused'; this.save(); this.audit('graceful_stop_verified'); }
      } else if (this.state.mode === 'running') {
        const reason = this.guard();
        if (reason) { this.pause(reason); return; }
        // A pending model change owns this session's next idle boundary. Handle
        // one durable AO mutation at a time; dispatch is fenced until verified.
        if (!this.mutating && this.modelChanges.native) {
          await this.serial(() => this.modelChanges.poll());
          if (this.state.mode !== 'running') return;
        }
        // Keep the original automatic Codex quota pause. An AGY-only fleet
        // may continue manual turns independently, but Turbo is never allowed
        // to work around exhausted or stale Codex account telemetry.
        const codexGate = this.guard({ session: { harness: 'codex' } });
        if (codexGate) {
          const sessions = await this.sessions();
          if (!sessions.some(s => active(s) && s.harness === 'agy')) {
            this.pause(codexGate); return;
          }
          if (this.state.run?.turbo) {
            this.state.run.turbo = false; this.save();
            this.audit('codex_turbo_disabled', { reason: codexGate });
          }
        }
        if (this.state.run?.turbo && this.now() >= (this.nextDispatchAt || 0)) {
          this.nextDispatchAt = this.now() + 120000;
          // Automatic mode only dispatches explicitly assigned queue entries.
          // It never invents or repeatedly requests new work when the queue is empty.
          const sessions = await this.sessions();
          const codexIds = new Set(sessions.filter(s => s.harness === 'codex').map(s => s.id));
          const tasks = this.state.tasks.filter(t => t.status === 'queued' && codexIds.has(t.agentId) && !['queued','submitting','transitioning','unverified','reconcile_required','resume_required'].includes(this.state.plans[t.agentId]?.status)).sort((a, b) => a.priority.localeCompare(b.priority));
          for (const t of tasks.slice(0, this.state.limits.concurrency)) {
            if (this.guard()) break;
            try { await this.dispatch(t.agentId); } catch (e) { this.audit('automatic_dispatch_blocked', { taskId: t.id, reason: e.message }); }
          }
          if (!tasks.length) this.pause('No assigned, useful queue work remains');
        }
      }
    } catch (e) { this.audit('tick_failed', { reason: e.message }); if (this.state.mode === 'running') this.pause('Runtime unavailable; dispatch paused'); }
    finally { this.tickRunning = false; }
  }
}

module.exports = { FleetController, writeJSON, active, busy, idle };
