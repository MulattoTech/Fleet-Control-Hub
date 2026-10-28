'use strict';
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { PROJECT } = require('./config');
const { provisionFirstCodex } = require('./bootstrap');
const { provisionAgent } = require('./agent-provision');
const exec = promisify(execFile);

class AOAdapter {
  constructor(config, { fetcher = fetch, runner = exec } = {}) {
    this.config = config;
    this.fetcher = fetcher;
    this.runner = runner;
  }
  async sessions() {
    const response = await this.fetcher(this.config.daemonUrl + '/api/v1/sessions', { signal: AbortSignal.timeout(3500) });
    if (!response.ok) throw Error('Orchestrator is unavailable (HTTP ' + response.status + ')');
    const value = await response.json();
    if (!Array.isArray(value.sessions)) throw Error('Orchestrator session response is invalid');
    return value.sessions;
  }
  async provisionCodex(onSubmit = () => {}) {
    return provisionFirstCodex(this.config, { runner: this.runner, sessions: () => this.sessions(), onSubmit });
  }
  async provisionSelection(selection, onSubmit = () => {}) {
    return provisionAgent(this.config, { runner: this.runner, sessions: () => this.sessions(), selection, onSubmit });
  }
  async command(action, id, message, beforeSubmit = () => {}) {
    if (!this.config.runtimeVerified) throw Error('The BabyTracker Orchestrator project/repository binding has not been verified');
    if (!['send', 'exit', 'kill'].includes(action)) throw Error('Unsupported scoped action');
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{2,89}$/.test(id)) throw Error('Invalid session identity');
    // Re-read membership immediately before every action; a caller's cached row is insufficient.
    const session = (await this.sessions()).find(s => s.id === id);
    if (!session || session.projectId !== PROJECT || session.isTerminated) throw Error('Session does not belong to the live BabyTracker project');
    if (!this.config.aoPath || !fs.existsSync(this.config.aoPath)) throw Error('The configured Orchestrator CLI is unavailable');
    const args = action === 'send'
      ? ['send', '--session', id, '--message', message]
      : ['session', action === 'kill' ? 'kill' : 'exit-agent', id, '--project', PROJECT, ...(action === 'exit' ? ['--json'] : [])];
    if (action === 'send' && session.mode === 'chat') args.push('--steer', '--client-message-id', require('node:crypto').randomUUID());
    beforeSubmit(session);
    // No shell, global process enumeration, daemon shutdown, or name-based process termination.
    await this.runner(this.config.aoPath, args, { windowsHide: true, timeout: 15000, maxBuffer: 100000, cwd: this.config.stateDir });
    return { submitted: true, sessionId: id, action };
  }
}

function quotaSnapshot(file, now = Date.now()) {
  const unavailable = reason => ({ available: false, fresh: false, remainingPercent: null, sampledAt: null, reason, source: 'Read-only Codex account telemetry', scope: 'shared account; not BabyTracker-specific consumption' });
  if (!file) return unavailable('No read-only Codex quota feed configured');
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return unavailable('Quota feed is unavailable or malformed'); }
  const sample = Date.parse(value.lastSuccessfulPoll || '');
  const heartbeat = Date.parse(value.heartbeatAt || '');
  if (!Number.isFinite(sample) || !Number.isFinite(heartbeat) || sample > now || heartbeat > now || now - sample > 25000 || now - heartbeat > 22000 || value.error || !['fresh', 'emergency_locked'].includes(value.status)) return unavailable('Quota feed is stale or not healthy');
  if (value.ordinaryUsageAllowed === false || value.status === 'emergency_locked') return unavailable('Codex use is currently stopped by the shared account guard');
  const windows = Array.isArray(value.windows) ? value.windows.filter(w => Number.isFinite(w.remainingPercent) && w.remainingPercent >= 0 && w.remainingPercent <= 100 && (!w.resetsAt || (Number.isFinite(Date.parse(w.resetsAt)) && Date.parse(w.resetsAt) > now))) : [];
  if (!windows.length) return unavailable('No valid unexpired quota window');
  return { available: true, fresh: true, sharedEmergencyGuard: { thresholdPercent:Number.isInteger(value.config?.thresholdPercent)?value.config.thresholdPercent:null, armed:value.config?.autoKillArmed===true, tripped:value.config?.tripped===true }, remainingPercent: Math.min(...windows.map(w => w.remainingPercent)), sampledAt: value.lastSuccessfulPoll, windows: windows.map(w => ({ label: w.label, remainingPercent: w.remainingPercent, resetsAt: w.resetsAt || null })), source: 'Read-only Codex account telemetry', scope: 'shared account; not BabyTracker-specific consumption' };
}

module.exports = { AOAdapter, quotaSnapshot };
