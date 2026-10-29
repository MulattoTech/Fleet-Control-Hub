'use strict';
const FleetRunUI = (() => {
  const root = document.getElementById('runSection');
  if (!root) return { refresh: async () => {} };
  root.classList.add('startup-panel');
  root.innerHTML = '<div class="startup-heading"><div><h2>MJobs run</h2><p>Start the current orchestrator and continue useful work with your saved limits.</p></div><span id="runBadge" class="startup-badge">Checking…</span></div>' +
    '<p id="runDetail" role="status" aria-live="polite"></p><div class="startup-actions"><button id="runStart" type="button" class="primary-button">Start</button><button id="runPause" type="button" class="ghost-button">Pause</button></div>' +
    '<p class="startup-footnote">Start checks usage, resumes the current primary when needed, and enables work. Set the reserve below to 0% to use the full allowance. No manual arming or refresh is required.</p>';
  const el = id => document.getElementById(id), key = 'mjobs-current-run-request-v1';
  let run = null, busy = false, reading = false, refreshQueued = false, error = null, timer, disposed = false, epoch = 0;
  let pending = null; try { pending = sessionStorage.getItem(key); } catch {}
  function save(value) { pending = value; try { if (value) sessionStorage.setItem(key, value); else sessionStorage.removeItem(key); } catch {} }
  async function request(url, body) {
    const response = await fetch(url, { cache: 'no-store', ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-ao-fleet': '1' }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
    const value = await response.json();
    if (!response.ok) throw Object.assign(Error(value.error || 'Controller refused the action'), { definitive: true });
    return value;
  }
  function render() {
    const exhausted = run?.quota?.fresh && run.quota.remainingPercent === 0;
    el('runBadge').textContent = error ? 'STATUS UNAVAILABLE' : exhausted ? 'ALLOWANCE EXHAUSTED' : run?.active ? 'STARTING' : run?.running ? 'RUNNING' : String(run?.phase || 'idle').toUpperCase();
    el('runDetail').textContent = error || run?.error || run?.blockedReasons?.join('; ') || (exhausted ? '0% remains. Work is paused. After the allowance resets, click Start.' : run?.active ? 'Preparing the run. Current status updates automatically.' : run?.running ? 'Work is enabled. Live activity and commits are shown below.' : 'Click Start to continue. Existing sessions and worktrees are preserved.');
    el('runStart').disabled = busy || !!run?.active || !!run?.running || !!exhausted;
    el('runStart').textContent = run?.active ? 'Starting…' : run?.running ? 'Running' : pending ? 'Retry Start' : 'Start';
    el('runPause').disabled = busy && !run?.active;
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
    if (busy || run?.active || run?.running) return;
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
  el('runStart').addEventListener('click', start); el('runPause').addEventListener('click', pause);
  async function poll() { await refresh(); if (!disposed) timer = setTimeout(poll, run?.active ? 1500 : 8000); }
  poll();
  return { refresh, status: () => run && structuredClone(run), dispose: () => { disposed = true; clearTimeout(timer); } };
})();
