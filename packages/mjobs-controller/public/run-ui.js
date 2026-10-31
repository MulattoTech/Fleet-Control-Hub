/* BEGIN GENERATED FLEET UI */
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
/* END GENERATED FLEET UI */
'use strict';
const FleetRunUI = (() => {
  const root = document.getElementById('runSection');
  if (!root) return { refresh: async () => {} };
  root.classList.add('startup-panel');
  root.innerHTML = '<div class="run-layout"><div class="run-main"><p class="run-kicker">MJobs orchestration</p><button id="runStart" type="button" class="fd-power" aria-label="Start MJobs" aria-describedby="runDetail" disabled><span class="fd-power-icon" aria-hidden="true"></span><span id="runStartLabel">Start MJobs</span></button><div class="run-actions"><button id="runPause" type="button" class="ghost-button">Pause dispatch</button><button id="runRefresh" type="button" class="ghost-button">Refresh status</button></div></div><div class="run-status"><h2>Continue your project</h2><span id="runBadge" class="fd-status" role="status">Checking</span><p id="runDetail" class="fd-reason" aria-live="polite">Reading the controller. No work has been requested.</p><div class="run-quota"><strong id="runRemaining" class="fd-num">—</strong><span id="runReserve">Waiting for allowance</span></div><p class="fd-footnote">Start checks the current primary and saved mission. Opening this page never starts work.</p></div></div>';
  const el = id => document.getElementById(id), key = 'mjobs-current-run-request-v1';
  let run = null, busy = false, reading = false, refreshQueued = false, error = null, timer, disposed = false, epoch = 0;
  let pending = null; try { pending = sessionStorage.getItem(key); } catch {}
  function save(value) { pending = value; try { if (value) sessionStorage.setItem(key, value); else sessionStorage.removeItem(key); } catch {} }
  async function request(url, body) {
    const response = await fetch(url, { cache: 'no-store', ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-ao-fleet': '1' }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
    const value = await response.json();
    if (!response.ok) throw Object.assign(Error(value.error || 'Controller refused the action'), { definitive: value.definitive === true || (response.status >= 400 && response.status < 500) });
    return value;
  }
  function view() { return FleetPower.present({ ...run, name:'MJobs', online:!!run, known:!!run, error, busy, retry:!!pending, pendingKind:run?.pending?.kind }); }
  function render() {
    const state=view();
    root.setAttribute('data-power-state',state.state); el('runBadge').textContent=state.status;
    el('runDetail').textContent=state.detail;el('runStartLabel').textContent=state.label;
    el('runStart').disabled=!state.canStart;el('runStart').setAttribute('aria-busy',String(state.state==='starting'));
    el('runRemaining').textContent=state.remaining===null?'—':state.remaining+'%';
    el('runReserve').textContent=state.reserve===null?'Saved reserve unavailable':'remaining / '+state.reserve+'% saved reserve';
    el('runPause').disabled=busy&&!run?.active;
  }
  async function refresh() {
    if (disposed) return; if (reading) { refreshQueued = true; return; } reading = true; const observed = epoch;
    try {
      const value = await request('/api/run');
      if (value.projectId !== 'mjobs-luna') throw Error('Unexpected project state');
      if (observed === epoch) { run = value; error = null; if (pending && run.requestId === pending) save(null); }
    } catch (e) { if (observed === epoch) error = e.message; }
    finally { reading = false; render(); if (refreshQueued && !disposed) { refreshQueued = false; queueMicrotask(refresh); } }
  }
  async function start() {
    if (busy || !view().canStart) return;
    busy = true; const mutation = ++epoch; error = null; if (!pending) save(crypto.randomUUID()); render();
    try { const result = await request('/api/run/start', { requestId: pending }); if (mutation === epoch) { run = result.run; save(null); } }
    catch (e) { if (mutation === epoch) { error = e.message; if (e.definitive) save(null); } }
    finally { if (mutation === epoch) { busy = false; render(); await refresh(); } }
  }
  async function pause() {
    const mutation = ++epoch; busy = true; render();
    try { await request('/api/master/pause', {}); if (mutation === epoch) { error = null; save(null); } }
    catch (e) { if (mutation === epoch) error = e.message; }
    finally { if (mutation === epoch) { busy = false; render(); await refresh(); } }
  }
  el('runStart').addEventListener('click', start); el('runPause').addEventListener('click', pause);el('runRefresh').addEventListener('click',refresh);
  async function poll() { await refresh(); if (!disposed) timer = setTimeout(poll, run?.active ? 1500 : 8000); }
  poll();
  return { refresh, status: () => run && structuredClone(run), dispose: () => { disposed = true; clearTimeout(timer); } };
})();
