'use strict';
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { PROJECT } = require('./config');
const runCLI = promisify(execFile);

const active = s => s && !s.isTerminated && !['exited','terminated','stopped'].includes(s.activity?.state || s.activity || s.status);
const busy = s => s?.busy === true || ['active','working'].includes(s.activity?.state || s.activity || s.status);
const clean = s => typeof s === 'string' ? s.slice(0, 100) : '';

function summarize(project, sessions, extra = {}) {
  const live = sessions.filter(active);
  return { id: project.id, name: clean(project.name) || project.id, kind: project.kind || 'unknown',
    sessions: live.length, working: live.filter(busy).length, idle: live.filter(s => !busy(s)).length,
    online: true, controlUrl: null, support: 'Registered in AO; no separate fleet-control adapter is installed', ...extra };
}
function createProjectHub(config, controller, { runner = runCLI, fetcher = fetch, now = Date.now } = {}) {
  let cached = null, at = 0;
  return async function projects() {
    if (cached && now() - at < 6000) return cached;
    let projects = [], allSessions = [], aoOnline = false, aoError = null;
    try {
      const result = await runner(config.aoPath, ['project','ls','--json'], {
        windowsHide: true, timeout: 5000, maxBuffer: 100000, cwd: config.repoPath
      });
      const response = JSON.parse(result.stdout);
      if (!Array.isArray(response.projects)) throw Error('Invalid AO project catalog');
      projects = response.projects.filter(p => p && typeof p.id === 'string' && /^[a-z0-9][a-z0-9-]{2,79}$/.test(p.id)).slice(0, 50);
      const sessionsResponse = await fetcher(config.daemonUrl + '/api/v1/sessions', { signal: AbortSignal.timeout(3500) });
      if (!sessionsResponse.ok) throw Error('AO session feed unavailable');
      const sessions = await sessionsResponse.json();
      if (!Array.isArray(sessions.sessions)) throw Error('Malformed AO session feed');
      allSessions = sessions.sessions; aoOnline = true;
    } catch (e) { aoError = String(e.message).slice(0, 140); }
    if (!aoOnline) return { at: new Date(now()).toISOString(), aoOnline, error: aoError, projects: [] };
    let mjobs = null;
    try {
      const r = await fetcher('http://127.0.0.1:8787/api/state', { signal: AbortSignal.timeout(2500) });
      if (r.ok) {
        const result = await r.json();
        if (result.projectId === 'mjobs-luna') mjobs = result;
      }
    } catch {}
    const projectRows = [];
    for (const p of projects) {
      let extra = {};
      if (p.id === PROJECT) {
        const s = await controller.snapshot();
        extra = { mode: s.mode, online: s.runtime.online, support: 'Full isolated Fleet Control',
          controlUrl: '/', quotaRemaining: s.quota.fresh ? s.quota.remainingPercent : null,
          sessions: s.summary.total, working: s.summary.working, idle: s.summary.available,
          canProvision: s.capabilities.explicitAgentProvisioning === true };
      } else if (p.id === 'mjobs-luna') {
        extra = { mode: mjobs ? 'active' : 'unavailable', online: !!mjobs,
          support: mjobs ? 'MJobs Fleet Control (existing controls preserved)' : 'MJobs Fleet Control unavailable',
          controlUrl: 'http://127.0.0.1:8787', sessions: mjobs ? (Array.isArray(mjobs.sessions) ? mjobs.sessions.length : null) : null,
          working: mjobs && Array.isArray(mjobs.sessions) ? mjobs.sessions.filter(busy).length : null,
          idle: mjobs && Array.isArray(mjobs.sessions) ? mjobs.sessions.filter(s => !busy(s)).length : null,
          canProvision: false };
      }
      projectRows.push(summarize(p, allSessions.filter(s => s.projectId === p.id), extra));
    }
    cached = { at: new Date(now()).toISOString(), aoOnline, projects: projectRows, portal: 'Read-only multi-project overview with native per-project controls' };
    at = now(); return cached;
  };
}
module.exports = { createProjectHub, summarize };
