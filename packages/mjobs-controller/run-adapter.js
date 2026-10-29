'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { unresolvedNativeReason } = require('./restore-fleet');
const { policyStatus } = require('./quota-policy');
const PROJECT = 'mjobs-luna';
const MODEL = 'gpt-5.6-sol';
const MISSION = 'Resume productive MJobs orchestration. Read AGENTS.md and the current requirement/acceptance checkpoint, inspect existing workers, branches, PRs and review receipts, then continue the highest-value unmet P0/P1 work. Reuse existing work before creating overlapping tasks. Default workers are GPT-5.6 Sol at Medium; recursive delegation is allowed within the configured project and resource limits. At most two GPT-6 Astra agents, both Medium, for difficult orchestration or independent review. Keep one integration owner, isolated worktrees and exact-head green required checks before protected PR merges. Preserve user work and production data. Do not send real employer submissions. Do not inflate acceptance or consume allowance with filler. Checkpoint and stop assigning when the provider allowance is exhausted or the user pauses/stops. Report actual commits, tests and remaining blockers.';
const activity = s => s?.activity?.state || s?.activity;
const primaryReady = s => !!s && !s.isTerminated && ['active','working','idle','waiting_input'].includes(activity(s)) &&
  (s.mode === 'chat' ? s.controllerVerified === true && ['ready','busy'].includes(s.controllerState) : s.mode === 'tui');

class RunAdapter {
  constructor(deps) { Object.assign(this, deps); }
  recoveryBlockReason() {
    const legacy = this.startup.status(), restore = this.master.restore;
    if (legacy.active || this.startup.task || this.startup.reconcileTask || this.startup.pendingMutations?.size) return 'A preserved-fleet recovery is still running';
    if (restore.state.active || restore.running) return 'A preserved-fleet restore is still running';
    const unresolved = unresolvedNativeReason(restore.state); if (unresolved) return unresolved;
    if (legacy.reconciliationRequired || legacy.phase === 'uncertain') {
      // This exact validation error was raised synchronously before RestoreFleet
      // committed a new operation. Preserve its historical record, but do not let
      // it block an unrelated, explicitly requested current-primary run forever.
      const rejectedBeforeSubmission = legacy.error?.code === 'STARTUP_FAILED' &&
        legacy.error?.message === 'Bounded restore requires only the saved MJobs primary and dispatch off' &&
        legacy.restoreStartAttempted === true && legacy.restoreStarted === false && legacy.restoreReceipt === null &&
        legacy.actionPending?.name === 'start existing RestoreFleet' &&
        legacy.options?.expectedProjectId === PROJECT && /^mjobs-luna-\d+$/.test(legacy.options?.boundedPrimaryId || '') &&
        legacy.options?.startWorkAfter === false && restore.state.phase === 'complete' &&
        typeof restore.state.source?.startupRunId === 'string' && restore.state.source.startupRunId !== legacy.runId &&
        Number.isFinite(Date.parse(restore.state.completedAt)) && Date.parse(restore.state.completedAt) <= Date.parse(legacy.startedAt) &&
        Object.keys(restore.state.inflight || {}).length === 0 && Object.keys(restore.state.errors || {}).length === 0;
      if (!rejectedBeforeSubmission) return 'A previous native recovery has an unverified outcome; its submission record must be reconciled';
    }
    return null;
  }
  quotaStatus() {
    const s = this.quota.status();
    // Start prepares a soft reserve policy; an old armed hard-stop must not hide
    // the Start action that releases that legacy setting intentionally.
    const policy = policyStatus({ ...s.config, autoKillArmed: false }, { fresh: s.fresh, selectedRemainingPercent: s.selectedRemainingPercent, ordinaryUsageAllowed: s.ordinaryUsageAllowed });
    return { fresh: s.fresh, remainingPercent: s.selectedRemainingPercent, minimumRemainingPercent: policy.minimumRemainingPercent, blocked: policy.blocked, reason: policy.reason };
  }
  async prepare(check) {
    check(); const reason = this.recoveryBlockReason(); if (reason) throw Error(reason);
    const legacyRevision = this.startup.status().revision;
    this.master.disableAutomaticDispatch();
    // Let an existing bounded dispatch/stop finish before changing its mode.
    const deadline = Date.now() + 25000;
    while (this.busy() || this.master.draining) { check(); if (Date.now() >= deadline) throw Error('An earlier control operation is still finishing; no work was submitted'); await new Promise(r => setTimeout(r, 250)); }
    check();
    if (this.master.locked()) {
      const emergency = this.master.status().emergency, age = Date.now() - Date.parse(emergency.checkedAt || '');
      if (emergency.phase !== 'holding_zero' || emergency.remainingTotal !== 0 || !Number.isFinite(age) || age < 0 || age >= 35000) throw Error('Emergency shutdown has not yet verified completion');
      const bytes = fs.readFileSync(this.master.latchPath);
      const revision = createHash('sha256').update(bytes).digest('hex');
      check(); this.master.rearm({ expectedRevision: revision });
    }
    if (this.master.drainState.enabled) { check(); this.master.cancelDrain(); }
    check(); this.quota.prepareForStart();
    const quotaDeadline = Date.now() + 20000;
    while (!this.quota.status().fresh) { check(); if (Date.now() >= quotaDeadline) throw Error('Usage reading is unavailable; no work was submitted'); await new Promise(r => setTimeout(r, 500)); }
    const quotaReason = this.quota.dispatchBlockReason(); if (quotaReason) throw Error(quotaReason);
    const watcherDeadline = Date.now() + 25000;
    while (await this.master.restore.watchdogDisarmed(false, () => { check(); return true; }) !== true) {
      check(); if (Date.now() >= watcherDeadline) throw Error('Emergency watcher has not confirmed release; no agent was started'); await new Promise(r => setTimeout(r, 400));
    }
    check(); if (this.master.locked()) throw Error('A newer Emergency Stop cancelled this Start');
    const resource = await this.master.restore.resourceReader(), limit = this.master.restore.config;
    if (!Number.isFinite(resource.ramGiB) || resource.ramGiB < limit.minFreeRamGiB || !Number.isFinite(resource.diskGiB) || resource.diskGiB < limit.minFreeDiskGiB || !Number.isFinite(resource.cpuPercent) || resource.cpuPercent >= limit.maxCpuPercent) throw Error('Verified machine capacity is insufficient for this run');
    check(); await this.verifyCodex(); check();
    const launch = this.launcher.reconcile({ acceptCompletedCancellation: true });
    if (launch.requiresReconciliation || launch.pending) throw Error('A prior Orchestrator launch is still unverified; no duplicate launch was sent');
    try { await this.getSessions(); }
    catch {
      check(); await this.launcher.launch('daemon', { beforeTrigger: () => { check(); const why = this.quota.dispatchBlockReason(); if (why || this.master.locked()) throw Error(why || 'Emergency Stop is active'); } });
      const until = Date.now() + 20000;
      for (;;) { check(); try { await this.getSessions(); break; } catch (e) { if (Date.now() >= until) throw Error('Orchestrator is unavailable after its launch request'); await new Promise(r => setTimeout(r, 500)); } }
    }
    check(); const project = await this.inspectProject(); check();
    const repo = String(project?.repo || '').replace(/\.git$/, '').replace(/^git@github.com:/, 'https://github.com/').toLowerCase();
    if (project?.id !== PROJECT || project.kind !== 'single_repo' || repo !== 'https://github.com/mulattotech/mjobs') throw Error('MJobs project/repository binding changed');
    if (legacyRevision !== this.startup.status().revision || this.recoveryBlockReason()) throw Error('Recovery state changed during Start');
    return { legacyRevision };
  }
  async inspect({ pending = null } = {}) {
    const all = await this.getSessions();
    if (!Array.isArray(all)) throw Error('Live session state is unavailable');
    const sessions = all.filter(s => s.projectId === PROJECT), roots = sessions.filter(s => !s.isTerminated && s.kind === 'orchestrator');
    if (roots.length > 1) throw Error('Multiple MJobs primaries exist; no duplicate was started');
    const primary = roots[0];
    if (primary && (primary.harness !== 'codex' || !/^mjobs-luna-\d+$/.test(primary.id))) throw Error('Current primary identity is unsupported');
    const ready = primaryReady(primary);
    const pendingIdentity = primary && (pending?.kind === 'resume' ? primary.id === pending.primaryId : pending?.kind === 'spawn' && Array.isArray(pending.previousIds) && !pending.previousIds.includes(primary.id) && primary.displayName === 'MJobs run ' + pending.requestId && primary.model === MODEL && primary.mode === 'chat');
    if (primary && !ready && !pendingIdentity && !(activity(primary) === 'exited' && (primary.mode === 'tui' || primary.controllerVerified && primary.controllerState === 'stopped'))) throw Error('Current primary health is unverified; no resume was sent');
    const name = String(primary?.displayName || '');
    return { primaryId: primary?.id || null, ready, busy: ready && (['active','working'].includes(activity(primary)) || primary.controllerState === 'busy'),
      idle: ready && ['idle','waiting_input'].includes(activity(primary)), mode: primary?.mode,
      createdForRequest: primary?.model === MODEL && primary?.mode === 'chat' && name.startsWith('MJobs run ') ? name.slice(10) : null, sessionIds: sessions.map(s => s.id) };
  }
  async launch(pending, check) {
    check(); const current = await this.inspect(); check();
    if (pending.kind === 'resume') {
      if (current.primaryId !== pending.primaryId || current.ready) throw Error('Primary changed before resume');
      await this.command(['session','resume-agent', pending.primaryId, '--project', PROJECT, '--json'], 30000, { runStart: true });
    } else {
      if (current.primaryId || current.sessionIds.some(id => !pending.previousIds.includes(id))) throw Error('Project roster changed before primary creation');
      await this.command(['spawn','--project',PROJECT,'--kind','orchestrator','--harness','codex','--mode','chat','--model',MODEL,'--effort','medium','--name','MJobs run ' + pending.requestId], 45000, { runStart: true });
    }
  }
  async instruct(current, messageId, check) {
    try {
      check(); const observed = await this.inspect(); check();
      if (observed.primaryId !== current.primaryId || !observed.ready || !observed.idle || observed.busy) throw Error('Primary became busy before the run instruction; no competing prompt was sent');
    } catch (error) { error.nativeSubmitted = false; throw error; }
    const args = ['send','--session',current.primaryId,'--message',MISSION];
    if (current.mode === 'chat') args.push('--steer','--client-message-id',messageId);
    await this.command(args, 30000, { runStart: true });
  }
  deps() {
    return { quota: () => this.quotaStatus(), recoveryBlockReason: () => this.recoveryBlockReason(),
      dispatchEnabled: () => this.master.sustain.config.enabled,
      blockReason: ({ prepared } = {}) => this.recoveryBlockReason() || (prepared ? this.master.locked() ? 'Emergency Stop is active' : this.quota.dispatchBlockReason() : null),
      pause: () => this.master.disableAutomaticDispatch(), prepare: check => this.prepare(check), inspect: pending => this.inspect({ pending }),
      launch: (pending, check) => this.launch(pending, check), instruct: (current, id, check) => this.instruct(current, id, check),
      enable: async check => { check(); const current = await this.inspect(); check(); if (!current.ready) throw Error('Primary is no longer ready'); this.master.sustain.enable(true); } };
  }
}
module.exports = { RunAdapter, primaryReady, MISSION };
