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
    if (input.emergencyLatched === true) return { ...result, state: 'locked', status: 'Emergency lock active', detail: 'Release the stop explicitly below. This alone does not start agents; Start MJobs becomes available when fresh quota exceeds your saved reserve.' };
    if (reasons) return { ...result, state: 'attention', status: 'Start blocked', detail: reasons };
    if (q.fresh !== true || result.remaining === null || result.reserve === null) return { ...result, state: 'checking', status: 'Waiting for usage', detail: 'A fresh usage reading and the saved reserve are required. Status updates automatically.' };
    if (q.blocked === true || result.remaining <= result.reserve) return { ...result, state: 'held', status: result.remaining === 0 ? 'Allowance exhausted' : 'Quota hold', detail: result.remaining <= result.reserve ? `${result.remaining}% remaining / ${result.reserve}% reserve. Start becomes available above the reserve; a reset never launches agents automatically.` : String(q.reason || 'The provider currently blocks new work.').slice(0, 300) };
    if (!['idle', 'paused', 'blocked', 'uncertain', 'running'].includes(input.phase)) return { ...result, state: 'attention', status: 'State needs review', detail: 'The controller reported an unrecognized run state. No launch is offered.' };
    if (input.phase === 'uncertain') return { ...result, state: 'attention', status: 'Verify pending launch', canStart: true, detail: 'Start checks the existing launch receipt. It must not create a duplicate operation.' };
    if (input.phase === 'blocked') {
      const previous = typeof input.lastFailure === 'string' ? input.lastFailure.slice(0, 240) : '';
      return { ...result, state: 'retry', status: 'Previous Start failed · retry available', canStart: true,
        detail: previous ? 'Last attempt: ' + previous + '. Click Start to check the current conditions and retry safely.' : 'The last attempt did not finish. Click Start to recheck and retry safely.' };
    }
    const paused = input.phase === 'paused' || input.phase === 'running';
    return { ...result, state: 'ready', status: paused ? 'Paused · press Start to resume' : 'Ready to start', canStart: true,
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
  root.innerHTML = `
    <div class="run-layout">
      <div class="run-main">
        <p class="run-kicker">MJobs orchestration</p>
        <button id="runStart" type="button" class="fd-power" aria-label="Start MJobs" aria-describedby="runDetail" disabled><span class="fd-power-icon" aria-hidden="true"></span><span id="runStartLabel">Start MJobs</span></button>
        <div class="run-actions">
          <button id="runUnlock" type="button" class="ghost-button" hidden>Release emergency lock…</button>
          <button id="runPause" type="button" class="ghost-button">Pause dispatch</button>
          <button id="runRefresh" type="button" class="ghost-button">Refresh status</button>
        </div>
      </div>
      <div class="run-status">
        <h2>Continue your project</h2><span id="runBadge" class="fd-status" role="status">Checking</span>
        <p id="runDetail" class="fd-reason" aria-live="polite">Reading the controller. No work has been requested.</p>
        <div class="run-quota"><strong id="runRemaining" class="fd-num">—</strong><span id="runReserve">Waiting for allowance</span></div>
        <p class="fd-footnote">Start checks the current primary and saved mission. Opening this page never starts work.</p>
      </div>
    </div>
    <div class="run-quick-settings" aria-label="Quick quota controls">
      <div class="run-setting"><label for="runReserveInput">Start / new-task reserve (%)</label><input id="runReserveInput" type="number" min="0" max="99" step="1" disabled></div>
      <div class="run-setting"><label for="runEmergencyInput">Emergency auto-stop cutoff (%)</label><input id="runEmergencyInput" type="number" min="0" max="50" step="1" disabled></div>
      <button id="runSaveLimits" type="button" class="ghost-button" disabled>Save limits</button>
      <p id="runSettingsFeedback" class="fd-footnote" role="status">Saving limits never starts the fleet. The optional hard stop must be armed separately in Usage settings.</p>
    </div>`;
  const el = id => document.getElementById(id), key = 'mjobs-current-run-request-v1';
  let run = null, busy = false, reading = false, refreshQueued = false, error = null, timer, disposed = false, epoch = 0;
  let settingsDirty = false, settingsBusy = false, settingsMessage = '';
  let pending = null; try { pending = sessionStorage.getItem(key); } catch {}
  function save(value) { pending = value; try { if (value) sessionStorage.setItem(key, value); else sessionStorage.removeItem(key); } catch {} }
  const runPrefix = typeof location !== 'undefined' && location.pathname.startsWith('/fleet/') ? '/fleet' : '';
  async function request(url, body) {
    const response = await fetch(runPrefix + url, { cache: 'no-store', ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-ao-fleet': '1' }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
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
    el('runUnlock').hidden=run?.emergencyLatched!==true;
    el('runUnlock').disabled=busy||settingsBusy;
    const q=run?.quota||{};
    if(!settingsDirty&&!settingsBusy){
      if(Number.isInteger(q.minimumRemainingPercent))el('runReserveInput').value=q.minimumRemainingPercent;
      if(Number.isInteger(q.thresholdPercent))el('runEmergencyInput').value=q.thresholdPercent;
    }
    const ready=Number.isInteger(q.minimumRemainingPercent)&&Number.isInteger(q.thresholdPercent);
    el('runReserveInput').disabled=!ready||settingsBusy;
    el('runEmergencyInput').disabled=!ready||settingsBusy;
    el('runSaveLimits').disabled=!ready||!settingsDirty||settingsBusy||busy;
    el('runSettingsFeedback').textContent=settingsMessage||(ready?'Hard stop '+(q.autoKillArmed?'ARMED':'DISARMED')+' at '+q.thresholdPercent+'%. Saving these limits never starts the fleet; arming automatic stop is a separate action.':'Read the current saved limits before editing.');
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
  async function saveLimits() {
    if(settingsBusy||busy||!run?.quota)return;
    const reserve=Number(el('runReserveInput').value),stop=Number(el('runEmergencyInput').value);
    if(!Number.isInteger(reserve)||reserve<0||reserve>99||!Number.isInteger(stop)||stop<0||stop>50){
      settingsMessage='Use whole percentages: 0–99 for the work reserve and 0–50 for auto-stop.';render();return;
    }
    const old=run.quota;
    if((reserve<old.minimumRemainingPercent||stop<old.thresholdPercent)&&!window.confirm(
      'Lowering a quota limit reduces the allowance kept in reserve. An enabled dispatcher may resume when its new reserve permits. Saving never starts a stopped fleet. Continue?'))return;
    if(old.autoKillArmed&&stop!==old.thresholdPercent&&!window.confirm(
      'Changing the emergency cutoff disarms the existing automatic stop. You must explicitly arm it again to protect a running fleet. Continue?'))return;
    settingsBusy=true;settingsMessage='Saving limits without starting agents…';const mutation=++epoch;render();
    try{
      const result=await request('/api/quota/config',{minimumRemainingPercent:reserve,thresholdPercent:stop});
      if(mutation===epoch){
        settingsDirty=false;
        settingsMessage='Saved: work reserve '+result.config.minimumRemainingPercent+'%, emergency cutoff '+result.config.thresholdPercent+'%. '+(result.config.autoKillArmed?'Auto-stop remains armed.':'Auto-stop is disarmed until you explicitly arm it.')+' No fleet start was requested.';
      }
      if(typeof FleetQuotaUI!=='undefined')FleetQuotaUI.refresh();
      if(typeof FleetStartupUI!=='undefined')FleetStartupUI.refresh(true);
    }catch(e){if(mutation===epoch)settingsMessage='Not saved: '+e.message;}
    finally{if(mutation===epoch){settingsBusy=false;render();await refresh();}}
  }
  for(const id of ['runReserveInput','runEmergencyInput'])el(id).addEventListener('input',()=>{
    settingsDirty=true;settingsMessage='Unsaved changes. Save to apply; no fleet starts when you save.';render();
  });
  el('runSaveLimits').addEventListener('click',saveLimits);
  el('runUnlock').addEventListener('click',()=>{if(run?.emergencyLatched&&typeof FleetMasterUI!=='undefined')FleetMasterUI.askRearm();});
  el('runStart').addEventListener('click', start); el('runPause').addEventListener('click', pause);el('runRefresh').addEventListener('click',refresh);
  async function poll() { await refresh(); if (!disposed) timer = setTimeout(poll, run?.active ? 1500 : 8000); }
  poll();
  return { refresh, status: () => run && structuredClone(run), dispose: () => { disposed = true; clearTimeout(timer); } };
})();
