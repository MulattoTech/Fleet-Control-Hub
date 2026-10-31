/* Fleet UI 1.0: pure presentation, never execution authority. */
var FleetPower = (() => {
  'use strict';
  const finite = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100;
  function present(input = {}) {
    const name = typeof input.name === 'string' && input.name.trim() ? input.name.slice(0, 80) : 'project';
    const result = { label: 'Start ' + name, state: 'unavailable', status: 'Controller unavailable',
      detail: 'Connect the project controller to read its current state.', canStart: false, remaining: null, reserve: null };
    const q = input.quota || {};
    if (q.fresh === true && finite(q.remainingPercent)) result.remaining = q.remainingPercent;
    if (finite(q.minimumRemainingPercent)) result.reserve = q.minimumRemainingPercent;
    if (input.online !== true || input.known !== true) return result;
    if (input.error) return { ...result, status: 'Status unavailable', detail: String(input.error).slice(0, 300) };
    const reasons = Array.isArray(input.blockedReasons) ? input.blockedReasons.filter(x => typeof x === 'string' && x).join('; ').slice(0, 400) : '';
    if (input.active === true || input.busy === true) return { ...result, state: 'starting', status: 'Starting', detail: 'Preparing the project. This operation is already in progress; no second launch is needed.' };
    if (input.running === true) return { ...result, state: 'running', status: 'Running', detail: 'Automatic work is enabled. Pause stops new assignments; running turns may finish.' };
    if (input.phase === 'uncertain' && !['spawn', 'resume'].includes(input.pendingKind)) return { ...result, state: 'attention', status: 'Needs reconciliation', detail: reasons || 'A previous delivery is unverified. Inspect its receipt before sending more work.' };
    if (reasons) return { ...result, state: 'attention', status: 'Start blocked', detail: reasons };
    if (q.fresh !== true || result.remaining === null || result.reserve === null) return { ...result, state: 'checking', status: 'Waiting for usage', detail: 'A fresh usage reading and the saved reserve are required. Status updates automatically.' };
    if (q.blocked === true || result.remaining <= result.reserve) return { ...result, state: 'held', status: result.remaining === 0 ? 'Allowance exhausted' : 'Quota hold', detail: result.remaining <= result.reserve ? `${result.remaining}% remaining / ${result.reserve}% reserve. Start becomes available above the reserve; a reset never launches agents automatically.` : String(q.reason || 'The provider currently blocks new work.').slice(0, 300) };
    if (!['idle', 'paused', 'blocked', 'uncertain'].includes(input.phase)) return { ...result, state: 'attention', status: 'State needs review', detail: 'The controller reported an unrecognized run state. No launch is offered.' };
    if (input.phase === 'uncertain') return { ...result, state: 'attention', status: 'Verify pending launch', canStart: true, detail: 'Start checks the existing launch receipt. It must not create a duplicate operation.' };
    return { ...result, state: 'ready', status: input.phase === 'paused' ? 'Paused · ready to start' : 'Ready to start', canStart: true,
      detail: input.retry ? 'Retry the same Start request. The controller verifies its original outcome before continuing.' : 'One click resumes the project mission with your saved limits. No prompt to write.' };
  }
  return Object.freeze({ present });
})();
if (typeof module === 'object' && module.exports) module.exports = FleetPower;
