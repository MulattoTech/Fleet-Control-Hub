'use strict';
const $ = id => document.getElementById(id);
const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function metric(value) { return Number.isInteger(value) ? String(value) : 'unavailable'; }
function card(p) {
  const allowedUrl = p.controlUrl === '/' ? '/' : p.controlUrl === 'http://127.0.0.1:8787' ? p.controlUrl : null;
  const action = allowedUrl ? '<a class="primary-button project-open" href="' + allowedUrl + '">Open ' + esc(p.name) + ' controls</a>'
    : '<span class="small-muted">Project controller not yet installed</span>';
  return '<article class="panel project-card"><div class="section-kicker">' + esc(p.kind) + ' / ' + esc(p.id) + '</div>' +
    '<div class="project-card-heading"><h2>' + esc(p.name) + '</h2><span class="state-chip ' + (p.online ? 'active' : 'blocked') + '">' + (p.online ? 'Connected' : 'Unavailable') + '</span></div>' +
    '<p class="project-description">' + esc(p.support) + '</p>' +
    '<div class="project-stats"><div><strong>' + metric(p.sessions) + '</strong><span>Agents</span></div><div><strong>' + metric(p.working) + '</strong><span>Working</span></div><div><strong>' + metric(p.idle) + '</strong><span>Available/idle</span></div></div>' +
    '<p class="helper">Control mode: ' + esc(p.mode || 'Read-only') +
    (p.quotaRemaining != null ? ' · Shared Codex remaining: ' + Number(p.quotaRemaining) + '%' : '') + '</p>' +
    '<div class="project-actions">' + action + '</div></article>';
}
async function refresh() {
  $('lastSync').textContent = 'Refreshing...';
  try {
    const r = await fetch('/api/projects', { signal: AbortSignal.timeout(7000) });
    const data = await r.json();
    if (!r.ok) throw Error(data.error || 'Projects read failed');
    $('hubStatus').textContent = data.aoOnline ? 'AO CONNECTED' : 'AO UNAVAILABLE';
    $('lastSync').textContent = new Date(data.at).toLocaleTimeString();
    $('hubNotice').textContent = data.aoOnline
      ? 'Projects are registered in Agent Orchestrator. This read-only overview does not start work. Use a project controller to make changes.'
      : 'Agent Orchestrator is unavailable: ' + (data.error || 'no verified session data');
    $('hubNotice').classList.toggle('warning', !data.aoOnline);
    $('projectCards').innerHTML = data.projects?.length ? data.projects.map(card).join('') : '<div class="empty">No verified projects currently available.</div>';
  } catch (error) {
    $('hubStatus').textContent = 'DISCONNECTED';
    $('hubNotice').textContent = 'Unable to refresh: ' + error.message + '. Previous project information may be stale.';
    $('hubNotice').classList.add('warning');
    $('lastSync').textContent = 'Unavailable';
  }
}
$('refreshProjects').addEventListener('click', refresh);
refresh();
setInterval(refresh, 10000);