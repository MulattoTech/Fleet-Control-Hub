'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// Ordinary Start owns one current project primary. Historical fleet restoration
// is a separate advanced operation; a page load never submits native work.
class RunController {
  constructor({ root, deps, audit = () => {}, now = Date.now, pollMs = 400, readyTimeoutMs = 45000 }) {
    Object.assign(this, { root, deps, audit, now, pollMs, readyTimeoutMs });
    this.file = path.join(root, 'run-state.json'); this.task = null; this.generation = 0; this.readError = null;
    try {
      this.state = JSON.parse(fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, ''));
      if (this.state.schemaVersion !== 1 || !['idle','starting','running','paused','blocked','uncertain'].includes(this.state.phase)) throw Error('Invalid run state');
    } catch (e) {
      this.state = { schemaVersion: 1, phase: 'idle', requestId: null, primaryId: null, pending: null, legacyRevision: null };
      if (e.code !== 'ENOENT') { this.readError = 'Run state is unreadable; preserve it before another launch'; this.state.phase = 'uncertain'; }
    }
    if (this.state.phase === 'starting' || this.state.pending) this.state.phase = 'uncertain';
    else if (this.state.phase === 'running') this.state.phase = 'paused';
  }
  save() {
    if (this.readError) throw Error(this.readError);
    this.state.updatedAt = new Date(this.now()).toISOString();
    const temp = this.file + '.tmp'; fs.writeFileSync(temp, JSON.stringify(this.state, null, 2)); fs.renameSync(temp, this.file);
  }
  status() {
    const quota = this.deps.quota();
    return { ...structuredClone(this.state), projectId: 'mjobs-luna', active: !!this.task,
      running: this.state.phase === 'running' && this.deps.dispatchEnabled(), quota,
      blockedReasons: [this.readError, this.deps.recoveryBlockReason?.()].filter(Boolean) };
  }
  ownsLegacy(legacy) { return !!this.state.legacyRevision && this.state.legacyRevision === legacy?.revision && !this.deps.recoveryBlockReason?.(); }
  start({ requestId } = {}) {
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(requestId)) throw Error('A stable Start request ID is required');
    if (this.readError) throw Error(this.readError);
    if (this.task || requestId === this.state.requestId || this.state.phase === 'running' && this.deps.dispatchEnabled()) {
      return { ok: true, idempotent: true, run: this.status() };
    }
    const priorPending = this.state.pending;
    this.state = { ...this.state, phase: 'starting', requestId, startedAt: new Date(this.now()).toISOString(), error: null, pending: priorPending };
    this.save();
    this.prepared = false;
    const generation = ++this.generation;
    const check = () => {
      if (generation !== this.generation) throw Error('Start was superseded by Pause or Stop');
      const reason = this.deps.blockReason?.({ prepared: this.prepared }); if (reason) throw Error(reason);
    };
    this.task = Promise.resolve().then(() => this.run(check)).catch(error => {
      this.deps.pause();
      this.state.phase = this.state.pending ? 'uncertain' : generation !== this.generation ? 'paused' : 'blocked';
      this.state.error = String(error.message || error).slice(0, 500); this.save();
      this.audit('run_start_blocked', { reason: this.state.error, pending: this.state.pending?.kind || null });
    }).finally(() => { this.task = null; });
    return { ok: true, idempotent: false, run: this.status() };
  }
  pause(reason = 'Paused by user') {
    ++this.generation; this.deps.pause();
    if (!this.readError) { this.state.phase = this.state.pending ? 'uncertain' : 'paused'; this.state.error = reason; this.save(); }
    return this.status();
  }
  observeQuota() {
    if (this.task || this.state.phase !== 'running') return;
    const quota = this.deps.quota();
    if (quota.fresh && quota.blocked) this.pause(quota.reason || 'Saved quota reserve reached');
  }
  async waitForIdle() { await this.task; return this.status(); }
  async verifyNative(check, pending) {
    const deadline = this.now() + this.readyTimeoutMs;
    do {
      check(); const current = await this.deps.inspect(pending); check();
      const expected = pending.kind === 'resume' ? current.primaryId === pending.primaryId :
        current.primaryId && !pending.previousIds.includes(current.primaryId) && current.createdForRequest === pending.requestId;
      if (expected && current.ready) {
        this.state.primaryId = current.primaryId; this.state.pending = null; this.save(); return current;
      }
      if (this.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, this.pollMs));
    } while (true);
    throw Error('Native primary launch is still unverified. The original operation is preserved and will not be replayed.');
  }
  async run(check) {
    this.deps.pause();
    // prepare owns emergency-watchdog verification, current quota refresh and
    // project/resource checks. It must call check before every mutation.
    const prepared = await this.deps.prepare(check); this.prepared = true; check();
    this.state.legacyRevision = prepared.legacyRevision || null; this.save();
    let current = await this.deps.inspect(this.state.pending); check();
    if (this.state.pending) {
      if (!['spawn','resume'].includes(this.state.pending.kind)) throw Error('Previous prompt delivery is unverified; inspect its receipt before another instruction');
      current = await this.verifyNative(check, this.state.pending);
    }
    if (!current.ready) {
      const pending = current.primaryId ? { kind: 'resume', primaryId: current.primaryId, requestId: this.state.requestId } :
        { kind: 'spawn', previousIds: current.sessionIds, requestId: this.state.requestId };
      this.state.pending = pending; this.save(); check();
      let failure;
      try { await this.deps.launch(pending, check); } catch (e) { failure = e; }
      check();
      try { current = await this.verifyNative(check, pending); } catch (e) { if (failure) e.message += ' ' + String(failure.message).slice(0, 180); throw e; }
    }
    this.state.primaryId = current.primaryId; this.save(); check();
    // Never steer an active root. A resumed idle root receives one instruction;
    // its durable submission record prevents a lost HTTP response from replaying it.
    if (!current.busy) {
      if (!current.idle) throw Error('The primary is waiting on a decision; resolve it in Orchestrator before dispatch');
      const messageId = randomUUID();
      this.state.pending = { kind: 'send', primaryId: current.primaryId, messageId, requestId: this.state.requestId }; this.save(); check();
      try { await this.deps.instruct(current, messageId, check); }
      catch (error) { if (error.nativeSubmitted === false) { this.state.pending = null; this.save(); } throw error; }
      this.state.pending = null; this.save(); check();
    }
    check(); await this.deps.enable(check); check();
    this.state.phase = 'running'; this.state.error = null; this.state.completedAt = new Date(this.now()).toISOString(); this.save();
    this.audit('run_started', { primaryId: current.primaryId, requestId: this.state.requestId });
  }
}
module.exports = { RunController };
