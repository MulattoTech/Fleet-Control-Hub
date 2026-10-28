'use strict';
const { PROJECT } = require('./config');
const stateOf = s => s?.activity?.state || s?.activity || s?.status;
const live = s => !!s && !s.isTerminated && !['exited', 'terminated', 'stopped', 'failed'].includes(stateOf(s));
const working = s => live(s) && ['active', 'working'].includes(stateOf(s));

// One authoritative calculation for admission checks AND the dashboard.
// Reading capacity never clears an uncertain delivery or writes a ledger.
function capacitySnapshot({ sessions, entries = {}, limit, now = Date.now(), cooldownMs = 120000, online = true }) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 32) throw Error('Invalid concurrency limit');
  if (!online) return { online: false, limit, used: null, free: null, full: null, executing: null, pending: null,
    unresolved: null, slots: [], byProvider: {}, reason: 'Concurrency unavailable: live AO session state could not be read. New work is not authorized.' };
  const slots = [], seen = new Set();
  for (const s of sessions) {
    if (s.projectId !== PROJECT || !live(s) || seen.has(s.id)) continue;
    seen.add(s.id);
    const record = entries[s.id];
    const ambiguous = !!record && (['reserved','uncertain'].includes(record.status) || !Number.isFinite(record.at));
    const remaining = record && Number.isFinite(record.at) ? Math.max(0, record.at + cooldownMs - now) : 0;
    const kind = working(s) ? 'active' : ambiguous ? 'unresolved' : remaining > 0 ? 'pending' : null;
    if (!kind) continue;
    slots.push({ id: s.id, name: s.displayName || s.id, harness: s.harness || 'unknown', role: s.kind || 'worker', kind,
      observedState: stateOf(s), reservationStatus: record?.status || null,
      holdSeconds: kind === 'pending' ? Math.ceil(remaining / 1000) : null,
      reason: kind === 'active' ? 'AO reports an executing turn' : kind === 'unresolved'
        ? 'Delivery unresolved; explicit reconciliation required, not an automatic timeout'
        : 'Recent submission settling / duplicate-send cooldown' });
  }
  const byProvider = {};
  for (const slot of slots) byProvider[slot.harness] = (byProvider[slot.harness] || 0) + 1;
  const count = kind => slots.filter(s => s.kind === kind).length;
  const used = slots.length, full = used >= limit;
  const owners = slots.map(s => s.id + ' [' + s.harness + ', ' + s.kind + ']').join('; ');
  return { online: true, limit, used, free: Math.max(0, limit - used), full,
    executing: count('active'), pending: count('pending'), unresolved: count('unresolved'), slots, byProvider,
    reason: full ? 'Concurrency full: ' + used + '/' + limit + ' slots occupied. ' + owners + '. Wait for a slot, or explicitly change the parallel-turn limit. Orchestrators and workers share this project limit.'
      : used + '/' + limit + ' parallel-turn slots occupied; ' + (limit - used) + ' free. Other quota, cooldown and task checks still apply.' };
}
module.exports = { capacitySnapshot, live, working };
