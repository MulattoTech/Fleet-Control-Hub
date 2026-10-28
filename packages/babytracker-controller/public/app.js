'use strict';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
let token = null, snapshot = null, refreshing = false, providers = [], limitsLoaded = false, quotaDirty = false, quotaSaving = false, concurrencyDirty = false, concurrencySaving = false;
function toast(message, error = false) { const node = document.createElement('div'); node.className = 'toast' + (error ? ' error' : ''); node.textContent = message; $('toastRoot').append(node); setTimeout(() => node.remove(), 9000); }
async function get(url) { const r = await fetch(url, { signal: AbortSignal.timeout(7000) }); const value = await r.json(); if (!r.ok) throw Error(value.error || 'Request failed'); return value; }
async function action(action, extra = {}) {
  try {
    if (!token) token = (await get('/api/session')).token;
    const r = await fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BabyTracker-Fleet': token }, body: JSON.stringify({ action, ...extra }), signal: AbortSignal.timeout(60000) });
    const value = await r.json();
    if (!r.ok) { if (r.status === 403) token = null; throw Error(value.error || 'Action failed'); }
    // A restarted controller creates a fresh action token. Clear the old token
    // without replaying any mutation; the next deliberate action obtains it.
    if (action === 'restart') token = null;
    toast(value.note || (value.ok === false ? 'Operation could not be verified. Inspect the current state.' : 'Controller action recorded.'), value.ok === false);
    await refresh(); return value;
  } catch (e) { toast(e.name === 'TimeoutError' ? 'Response timed out. Refresh and inspect the controller before retrying; an action may have been submitted.' : e.message, true); throw e; }
}
function render(s) {
  snapshot = s;
  renderCapacity(s);
  const qp=s.quotaPolicy;
  if(qp){
    $('quotaPolicyPanel').classList.toggle('blocked',qp.blocked);
    $('quotaPolicyState').textContent=qp.blocked?'CODEX START / NEW WORK BLOCKED':'CODEX QUOTA ALLOWS START / NEW WORK';
    $('quotaPolicyReason').textContent=qp.reason+' Fleet status: '+s.mode+'. Runtime health is separate from quota eligibility.';
    $('quotaPolicyEmergency').textContent=qp.note;
    if(!quotaDirty)$('quotaMinimum').value=qp.configuredMinimumRemainingPercent;
    $('quotaMinimum').min=qp.minimumAllowedPercent;
    const noAgy=!s.sessions.some(a=>a.harness==='agy'&&a.runtimeActive===true);
    const start=document.querySelector('[data-action="start"]');
    start.disabled=s.mode==='running'||!!s.emergency||(qp.blocked&&noAgy);
    start.textContent=s.mode==='running'?'Already started':qp.blocked&&noAgy?'Start blocked by quota':'Start Fleet';
    start.title=qp.blocked?qp.reason:'';
    document.querySelector('[data-action="all-hands"]').disabled=qp.blocked||s.mode!=='running';
    $('turbo').disabled=(!s.run?.turbo&&qp.blocked)||s.mode!=='running';
  }

  $('mode').textContent = s.mode.toUpperCase(); $('sync').textContent = 'Observed ' + new Date(s.observedAt).toLocaleTimeString();
  $('total').textContent = s.runtime.online ? s.summary.total : '—'; $('working').textContent = s.runtime.online ? s.summary.working : '—'; $('available').textContent = s.runtime.online ? s.summary.available : '—';
  $('quota').textContent = s.quota.fresh ? s.quota.remainingPercent + '%' : '—'; $('quotaNote').textContent = s.quota.fresh ? 'Shared account · current sample' : s.quota.reason;
  $('notice').textContent = !s.runtime.online ? s.runtime.reason + '. No live activity is being claimed.' : s.emergency ? 'Emergency stop: ' + s.emergency.phase + '. Remaining sessions: ' + (s.emergency.remaining ?? 'unverified') : (s.dispatchBlocker || s.codexDispatchBlocker || (s.capacity?.full ? s.capacity.reason : null)) || 'Bounded dispatch is enabled. The queue and run budget govern new assignments.';
  $('notice').classList.toggle('warning', !s.runtime.online || !!s.dispatchBlocker || !!s.codexDispatchBlocker || !!s.emergency || !!s.capacity?.full);
  $('resources').textContent = 'Free RAM: ' + s.resources.freeMemoryGiB.toFixed(1) + ' / ' + s.resources.totalMemoryGiB.toFixed(1) + ' GiB · CPU: ' + (s.resources.cpuPercent === null ? 'unavailable' : s.resources.cpuPercent + '%') + ' · Disk I/O: unavailable · Run dispatches: ' + (s.run?.dispatches ?? 0) + ' / ' + s.limits.maxDispatches;
  $('turbo').textContent = s.run?.turbo ? 'Disable Turbo' : 'Enable Turbo';
  $('reconcileAgent').hidden = !['pending', 'uncertain'].includes(s.provisioning?.status);
  const agy = s.agyUsage || {};
  $('agyInfo').textContent = agy.fresh && agy.remainingPercent !== null ? 'Google AGY remaining: ' + agy.remainingPercent + '% (observed, not automatically polled; no verified auto cutoff)' : 'Google AGY quota unknown/stale. AGY may be dispatched manually only with a separate confirmation; no automatic percentage cutoff.';
  $('rows').innerHTML = s.sessions.length ? s.sessions.map(a => '<tr><td><strong>' + esc(a.name) + '</strong><div class="subtext">' + esc(a.id) + '</div>' + (s.plans?.[a.id] ? '<div class="subtext">' + (s.plans[a.id].status === 'applied_next_turn' ? 'Next turn: ' : s.plans[a.id].status === 'staged' ? 'UNAPPLIED preference only: ' : 'Model change ' + esc(s.plans[a.id].status.replace(/_/g, ' ')) + ': ') + esc(s.plans[a.id].harness) + ' ' + esc(s.plans[a.id].model) + (s.plans[a.id].status === 'staged' ? ' (NOT applied)' : '') + '</div>' : '') + '</td><td><strong>' + esc(a.harness === 'codex' ? 'Codex' : a.harness === 'agy' ? 'AGY / Gemini' : a.harness) + '</strong><div>' + esc(a.model === 'unknown' ? 'Native default (model unreported)' : a.model) + '</div><div class="subtext">' + esc(a.harness) + (a.effort ? ' · ' + esc(a.effort) : '') + '</div></td><td><span class="state-chip ' + (a.busy ? 'active' : a.label === 'Blocked' ? 'blocked' : '') + '">' + esc(a.label) + '</span></td><td>' + (a.issue ? '<a href="https://github.com/MulattoTech/BabyTracker/issues/' + Number(a.issue) + '">Issue #' + Number(a.issue) + '</a>' : 'No reserved task') + '<div class="subtext">' + a.prs.map(p => 'PR #' + Number(p.number) + ' · ' + esc(p.ci || p.state || 'unknown')).join(', ') + '</div></td><td>' + (a.unresolvedDelivery ? 'Manual reconciliation needed' : a.cooldownSeconds ? a.cooldownSeconds + 's cooldown' : 'No reliable ETA') + '</td><td><div class="row-actions"><button class="small-action" data-session="' + esc(a.id) + '" data-op="nudge">Nudge</button><button class="small-action accent" data-session="' + esc(a.id) + '" data-op="find-work">Find Work</button><button class="small-action" data-session="' + esc(a.id) + '" data-op="plan">Change model</button>' + (s.plans?.[a.id]?.status === 'queued' ? '<button class="small-action" data-session="' + esc(a.id) + '" data-op="model-cancel">Cancel change</button>' : '') + (['unverified','reconcile_required'].includes(s.plans?.[a.id]?.status) ? '<button class="small-action" data-session="' + esc(a.id) + '" data-op="model-reconcile">Verify change</button>' : '') + (s.plans?.[a.id]?.status === 'resume_required' ? '<button class="small-action" data-session="' + esc(a.id) + '" data-op="model-resume">Resume change</button>' : '') + '</div></td></tr>').join('') : '<tr><td colspan="6" class="empty">' + (s.runtime.online ? 'No BabyTracker sessions are registered. MJobs agents are excluded. Click Start Fleet to provision one verified BabyTracker Codex orchestrator. No worker is created merely by opening this dashboard.' : 'Orchestrator runtime is unavailable. The local controller and saved task queue remain accessible.') + '</td></tr>';
  $('tasks').innerHTML = s.tasks.length ? s.tasks.map(t => '<div class="task-item"><div><strong>' + esc(t.priority) + ' · ' + esc(t.title) + '</strong><p><a href="https://github.com/MulattoTech/BabyTracker/issues/' + Number(t.issue) + '">Requirement #' + Number(t.issue) + '</a> · ' + esc(t.status) + ' · Acceptance: ' + esc(t.acceptance) + '</p><p>' + esc(t.files.join(', ')) + '</p></div>' + (['proposed', 'queued'].includes(t.status) ? '<div><select aria-label="Assign worker" data-task="' + esc(t.id) + '"><option value="">Choose available worker</option>' + s.sessions.filter(a => a.idle).map(a => '<option value="' + esc(a.id) + '"' + (a.id === t.agentId ? ' selected' : '') + '>' + esc(a.name) + '</option>').join('') + '</select></div>' : '') + '</div>').join('') : '<div class="empty">No assigned tasks. Add a real GitHub issue with a bounded scope to propose the next useful change.</div>';
  for (const button of $('rows').querySelectorAll('button[data-op="find-work"],button[data-op="nudge"]')) {
    const agent = s.sessions.find(a => a.id === button.dataset.session);
    button.disabled = !agent?.canDispatch;
    button.title = agent?.reason || 'Live dispatch eligibility unavailable';
  }
  const allHands = document.querySelector('[data-action="all-hands"]');
  allHands.disabled = s.mode !== 'running' || !s.runtime.online || !s.sessions.some(a => a.harness === 'codex' && a.canDispatch);
  allHands.title = s.capacity?.full ? s.capacity.reason : 'Dispatch eligible idle Codex agents; Google AGY requires individual confirmation';
  if (!limitsLoaded) { for (const [key, value] of Object.entries(s.limits)) $('limitsForm').elements[key].value = value; limitsLoaded = true; }
}
async function refresh() {
  if (refreshing) return; refreshing = true;
  try { render(await get('/api/state')); }
  catch (e) { $('sync').textContent = 'Disconnected · snapshot stale'; $('notice').textContent = 'Controller unavailable: ' + e.message + '. Displayed values are historical until refreshed.'; $('notice').classList.add('warning'); }
  finally { refreshing = false; }
}
document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', async () => {
  const name = button.dataset.action;
  if(name==='start'&&snapshot?.quotaPolicy?.blocked&&!snapshot.sessions.some(a=>a.harness==='agy'&&a.runtimeActive===true))return toast(snapshot.quotaPolicy.reason,true);
  if (['emergency', 'drain', 'start', 'release'].includes(name) && !confirm(({ emergency: 'Stop only BabyTracker runtime sessions now? Uncommitted files and branches are preserved.', drain: 'Ask BabyTracker workers to checkpoint and stop?', start: 'Enable this bounded BabyTracker run? If none exists, Start may provision one Codex orchestrator (which may use quota); tasks still require explicit assignment or Find Work.', release: 'Release the BabyTracker emergency latch after verifying its sessions have stopped?' })[name])) return;
  button.disabled = true; try { await action(name); } catch {} finally { button.disabled = false; if(snapshot)render(snapshot); }
}));
$('quotaMinimum').addEventListener('input',()=>{quotaDirty=true;$('quotaPolicyFeedback').textContent='UNSAVED quota change. Save to apply. Shared emergency protection stays unchanged.';});
$('quotaMinimumSave').addEventListener('click',async()=>{
  if(quotaSaving)return;const value=Number($('quotaMinimum').value),floor=snapshot?.quotaPolicy?.minimumAllowedPercent??7;
  if(!Number.isInteger(value)||value<floor||value>99)return toast('Quota limit must be '+floor+' to 99%.',true);
  if(value<snapshot.limits.minimumRemainingPercent&&!confirm('Lower BabyTracker start/new-work limit to '+value+'%? A running scheduler may resume Codex tasks. Shared emergency protection is unchanged; less headroom increases overshoot risk.'))return;
  quotaSaving=true;$('quotaMinimumSave').disabled=true;
  try{const result=await action('quota-policy',{minimumRemainingPercent:value});quotaDirty=false;limitsLoaded=false;$('quotaPolicyFeedback').textContent=result.note;await refresh();}
  catch{}finally{quotaSaving=false;$('quotaMinimumSave').disabled=false;}
});
$('refresh').addEventListener('click', refresh);
$('turbo').addEventListener('click', () => action('turbo', { enabled: !snapshot?.run?.turbo }).catch(() => {}));
$('limitsForm').addEventListener('submit', async event => { event.preventDefault(); const limits = Object.fromEntries([...new FormData(event.target)].map(([k, v]) => [k, Number(v)])); await action('limits', { limits }).catch(() => {}); });
$('taskForm').addEventListener('submit', async event => { event.preventDefault(); const form = new FormData(event.target); try { await action('task', { task: { title: form.get('title'), issue: Number(form.get('issue')), priority: form.get('priority'), files: form.get('files').split(/\r?\n/).map(s => s.trim()).filter(Boolean) } }); event.target.reset(); } catch {} });
$('tasks').addEventListener('change', event => { const select = event.target.closest('select[data-task]'); if (select?.value) action('assign', { taskId: select.dataset.task, agentId: select.value }).catch(() => {}); });
$('rows').addEventListener('click', async event => {
  const button = event.target.closest('button[data-session]'); if (!button) return;
  const op = button.dataset.op;
  if (['model-cancel','model-reconcile','model-resume'].includes(op)) {
    if (op === 'model-cancel' && !confirm('Cancel this queued model change without stopping the current turn?')) return;
    return action(op,{ id: button.dataset.session }).catch(() => {});
  }
  if (op !== 'plan') {
    const found = snapshot?.sessions.find(s => s.id === button.dataset.session);
    const agy = found?.harness === 'agy';
    if (agy && !confirm('AGY has no verified automatic percentage quota cutoff. Send exactly one bounded manual instruction? This may use your Google AI allowance.')) return;
    return action(button.dataset.op, { id: button.dataset.session, acknowledgeUnknownAgyQuota: agy }).catch(() => {});
  }
  try {
    providers = (await get('/api/providers')).providers.filter(p => p.available && p.models.length);
    if (!providers.length) return toast('No provider model catalog has been verified for this installation yet.', true);
    $('planAgent').value = button.dataset.session; $('planProvider').innerHTML = providers.map(p => '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>').join('');
    const current = snapshot.sessions.find(s => s.id === button.dataset.session);
    const prior = snapshot.plans?.[current.id];
    if (providers.some(p => p.id === prior?.harness)) $('planProvider').value = prior.harness;
    else if (providers.some(p => p.id === current.harness)) $('planProvider').value = current.harness;
    updateModels();
    const model = providers.find(p => p.id === $('planProvider').value)?.models.find(m => m.id === prior?.model || m.id === current.model);
    if (model) $('planModel').value = model.id;
    updateEfforts();
    if (model && model.efforts.includes(prior?.effort)) $('planEffort').value = prior.effort;
    $('planDialog').showModal();
  } catch (e) { toast(e.message, true); }
});
function updateModels() { const provider = providers.find(p => p.id === $('planProvider').value); $('planModel').innerHTML = (provider?.models || []).map(m => '<option value="' + esc(m.id) + '">' + esc(m.name) + '</option>').join(''); updateEfforts(); }
function updateEfforts() { const model = providers.find(p => p.id === $('planProvider').value)?.models.find(m => m.id === $('planModel').value); $('planEffort').innerHTML = (model?.efforts || []).map(e => '<option>' + esc(e) + '</option>').join(''); }
$('planProvider').addEventListener('change', updateModels); $('planModel').addEventListener('change', updateEfforts);
$('savePlan').addEventListener('click', async () => {
  const id=$('planAgent').value, source=snapshot?.sessions.find(a => a.id === id);
  if (!source) return toast('Session no longer exists; refresh before changing models.', true);
  const target=$('planProvider').value, agy=target==='agy';
  if (source.harness === 'agy' && agy) return toast('The installed AO cannot change the model within an AGY Terminal session in place. Use /model inside the AGY terminal, or create a new AGY agent.',true);
  const note=source.harness===target && target==='codex' && source.mode==='chat'
    ? 'Save this Codex model/effort for the NEXT turn in the same session? Any active turn will finish on its existing model.'
    : 'Queue a safe model handoff in the same BabyTracker AO session? If working, it will finish its current turn first. No task or worktree will be destroyed.';
  if (!confirm(note)) return;
  if (agy && !confirm('AGY / Google Gemini quota has no verified automatic cutoff. Applying the provider change may start AGY and consume Google usage. Proceed?')) return;
  if (source.kind==='orchestrator' && source.harness!==target && !confirm('This is the PRIMARY orchestrator. The provider will change after a verified handoff. Confirm?')) return;
  $('savePlan').disabled=true;
  try {
    const result=await action('model-change',{ id, plan: { harness:target, model:$('planModel').value, effort:$('planEffort').value,
      mode:agy?'tui':'chat', acknowledgeUnknownAgyQuota:agy, acknowledgeOrchestratorHandoff:source.kind==='orchestrator' }});
    $('planDialog').close();
    if (result.status==='blocked' || result.status==='unverified') toast('Change requires attention: '+result.status,true);
  } catch {} finally { $('savePlan').disabled=false; }
});
async function loadAgentProviders() {
  const catalog = await get('/api/providers');
  providers = (catalog.providers || []).filter(p => p.available && p.models?.length && ['codex', 'agy'].includes(p.id));
  if (!providers.length) throw Error('No locally verified Codex or AGY models are currently available');
}
function fillAgentModels() {
  const p = providers.find(x => x.id === $('newAgentProvider').value);
  $('newAgentModel').innerHTML = (p?.models || []).map(m => '<option value="' + esc(m.id) + '">' + esc(m.name) + '</option>').join('');
  fillAgentEfforts();
  const agy = p?.id === 'agy';
  $('agentProviderWarning').textContent = agy
    ? 'AGY / Google Gemini: independent quota; no verified automatic percentage cutoff. Explicit creation and manual turns only. Google AI credit overages should be disabled in your AGY account.'
    : 'Codex: creation and dispatch require fresh shared-account usage, respecting your remaining quota threshold.';
}
function fillAgentEfforts() {
  const m = providers.find(p => p.id === $('newAgentProvider').value)?.models.find(m => m.id === $('newAgentModel').value);
  $('newAgentEffort').innerHTML = (m?.efforts || []).map(e => '<option value="' + esc(e) + '">' + esc(e) + '</option>').join('');
  if (m?.defaultEffort) $('newAgentEffort').value = m.defaultEffort;
}
$('addAgent').addEventListener('click', async () => {
  try {
    await loadAgentProviders();
    $('newAgentProvider').innerHTML = providers.map(p => '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>').join('');
    $('newAgentName').value = 'BabyTracker Worker ' + (snapshot?.summary.total + 1 || 1);
    fillAgentModels();
    $('addAgentDialog').showModal();
  } catch (e) { toast(e.message, true); }
});
$('newAgentProvider').addEventListener('change', fillAgentModels);
$('newAgentModel').addEventListener('change', fillAgentEfforts);
$('createAgent').addEventListener('click', async () => {
  const agent = { name: $('newAgentName').value.trim(), kind: $('newAgentKind').value,
    harness: $('newAgentProvider').value, model: $('newAgentModel').value,
    effort: $('newAgentEffort').value, acknowledgeUnknownAgyQuota: false };
  if (agent.name.length < 3 || agent.name.length > 80) return toast('Choose a descriptive agent name (3-80 characters).', true);
  if (agent.harness === 'agy') {
    if (!confirm('Create one AGY agent with the selected Google Gemini model? This may use your Google AI allowance. Native quota reporting is currently unverified, and automatic AGY dispatch is disabled.')) return;
    agent.acknowledgeUnknownAgyQuota = true;
  } else if (!confirm('Create one Codex agent? This may consume shared Codex allowance, guarded by the configured usage threshold.')) return;
  $('createAgent').disabled = true;
  try { await action('add-agent', { agent }); $('addAgentDialog').close(); }
  catch {} finally { $('createAgent').disabled = false; }
});
$('reconcileAgent').addEventListener('click', () => { if (confirm('Check AO twice for the previous agent. If no BabyTracker session exists and at least 30 seconds passed, record the rejected attempt and allow a new spawn? This does not launch an agent.')) action('reconcile-agent', { confirmNoSession: true }).catch(() => {}); });

function renderCapacity(s) {
  const c = s.capacity;
  if (!c) return;
  $('capacityPanel').classList.toggle('warning', !c.online || c.full);
  $('capacityState').textContent = c.online ? 'Parallel work: ' + c.used + ' / ' + c.limit + ' slots occupied' : 'Parallel work: state unavailable';
  $('capacityReason').textContent = c.reason + (c.online ? ' Running: ' + c.executing + '; settling submissions: ' + c.pending + '; unresolved deliveries: ' + c.unresolved + '.' : '');
  $('capacityOwners').innerHTML = c.online ? c.slots.map(x => '<div class="capacity-owner"><strong>' + esc(x.id) + ' / ' + esc(x.harness) + '</strong><span>' + esc(x.name) + ' (' + esc(x.role) + ')</span><small>' + esc(x.reason) + (x.holdSeconds ? ' / up to ' + x.holdSeconds + 's cooldown' : '') + '</small></div>').join('') || '<p>No occupied slots observed.</p>' : '<p>No agents are being claimed idle while the runtime is unreachable.</p>';
  if (!concurrencyDirty) $('concurrencyLimit').value = c.limit;
  $('concurrencySave').disabled = concurrencySaving || ['emergency','draining'].includes(s.mode);
}
$('concurrencyLimit').addEventListener('input', () => { concurrencyDirty = true; $('concurrencyFeedback').textContent = 'UNSAVED parallel-turn limit. Saving does not send work, stop turns, or change quota protection.'; });
$('concurrencySave').addEventListener('click', async () => {
  if (concurrencySaving) return;
  const value = Number($('concurrencyLimit').value);
  if (!Number.isInteger(value) || value < 1 || value > 32) return toast('Parallel-turn limit must be 1 to 32.', true);
  if (value > snapshot.limits.concurrency && !confirm('Raise the shared BabyTracker parallel-turn limit from ' + snapshot.limits.concurrency + ' to ' + value + '? Existing automatic scheduling may use the extra slots. Resource and provider usage can increase. The 7% quota safeguard is not changed.')) return;
  concurrencySaving = true; $('concurrencySave').disabled = true;
  try { const result = await action('concurrency-policy', { concurrency: value }); concurrencyDirty = false; limitsLoaded = false; $('concurrencyFeedback').textContent = result.note; await refresh(); }
  catch {} finally { concurrencySaving = false; if (snapshot) renderCapacity(snapshot); }
});

refresh(); setInterval(refresh, 8000);
