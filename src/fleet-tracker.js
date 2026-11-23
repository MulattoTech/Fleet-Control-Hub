'use strict';

const {readFile} = require('node:fs/promises');
const {execFile} = require('node:child_process');
const {tmpdir} = require('node:os');
const path = require('node:path');
const {promisify} = require('node:util');
const {defaultTrackerProject, projects: projectConfig} = require('../projects.json');
const {createPublishedAcceptanceReader} = require('./published-acceptance');
const {createProjectDesktopActivity} = require('./project-desktop-activity');

const TRACKER = '/mission-control/analytics/';
const OBSERVER = 'http://127.0.0.1:18726';
const ASSETS = new Map([
  ['', ['index.html', 'text/html; charset=utf-8']],
  ['atlas.css', ['atlas.css', 'text/css; charset=utf-8']],
  ['atlas.js', ['atlas.js', 'text/javascript; charset=utf-8']],
  ['source-status.js', ['source-status.js', 'text/javascript; charset=utf-8']],
]);
const ASSET_ROOT = path.join(__dirname, '..', 'packages', 'mjobs-controller', 'remote', 'public', 'analytics');
const execFileAsync = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/;
const TRACKERS = Object.fromEntries(Object.entries(projectConfig).flatMap(([id, project]) =>
  project.tracker ? [[id, {repository: project.repository, ...project.tracker}]] : []));

async function resolvePublicGitHead({repository, branch}, run = execFileAsync) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || repository.includes('..') ||
      !/^[A-Za-z0-9][\w./-]*$/.test(branch) || branch.includes('..')) throw Error('INVALID_PROJECT_SOURCE');
  const ref = 'refs/heads/' + branch;
  const remote = `https://github.com/${repository}.git`;
  const {stdout} = await run('git', ['-c', 'credential.helper=', '-c', 'core.askPass=',
    '-c', 'http.followRedirects=false', 'ls-remote', '--refs', '--exit-code', remote, ref], {
    cwd: tmpdir(), encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 4096,
    env: {...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never'},
  });
  const [sha, returnedRef] = stdout.trim().split('\t');
  if (!SHA.test(sha) || returnedRef !== ref) throw Error('PUBLISHED_REF_UNAVAILABLE');
  return sha;
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 10000 ? value : null;
}

function localCounts(value) {
  if (!value) return null;
  const result = {pass: count(value.pass), partial: count(value.partial), not_run: count(value.notRun), total: count(value.total)};
  return Object.values(result).every(value => value !== null) ? result : null;
}

function timestamp(value) {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString() : null;
}

async function readCampaigns(fetcher = globalThis.fetch) {
  try {
    const response = await fetcher(`${OBSERVER}/api/progress/campaigns`, {
      signal: AbortSignal.timeout(2500), redirect: 'error', cache: 'no-store',
    });
    if (!response.ok || !response.body) return null;
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 524288) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (input.available !== true || !Array.isArray(input.campaigns)) return null;
    return input.campaigns.slice(0, 20).flatMap(row => {
      if (!/^MJ-REQ-\d{3}$/.test(row?.requirement_id)) return [];
      const scoreboard = Object.fromEntries(['total','verified_pass','PARTIAL','NOT_RUN','FAIL','BLOCKED']
        .map(key => [key, count(row.scoreboard?.[key])]));
      if (Object.values(scoreboard).includes(null)) return [];
      return [{requirement_id: row.requirement_id, updated_at_utc: timestamp(row.updated_at_utc),
        source_revision: SHA.test(row.source_revision) ? row.source_revision : null, scoreboard}];
    });
  } catch { return null; }
}

function createFleetTracker({projects = TRACKERS, defaultProject = defaultTrackerProject, mission, campaignReader = readCampaigns,
    observationReader,
    acceptance = createPublishedAcceptanceReader({
      projects: Object.fromEntries(Object.entries(projects).filter(([, p]) => p.originalPath && p.referencePath)),
      resolveCommit: resolvePublicGitHead,
    }), desktop = createProjectDesktopActivity({projectId: 'mjobs', originUrl: OBSERVER})} = {}) {
  const list = Object.entries(projects).map(([project_id, entry]) => ({
    project_id, name: entry.name, repository: entry.repository, branch: entry.branch,
  })).sort((a,b) => a.name.localeCompare(b.name));

  async function localProgress() {
    const [progress, campaigns] = await Promise.allSettled([mission?.status(), campaignReader()]);
    const raw = progress.status === 'fulfilled' ? progress.value : null;
    const localAvailable = raw?.available === true;
    return {status: localAvailable ? 'CURRENT' : 'UNAVAILABLE',
      source: 'local-checkout-and-campaign-observer', observed_at: timestamp(raw?.observedAt),
      checkout_commit: SHA.test(raw?.checkoutHeadSha) ? raw.checkoutHeadSha : null,
      checkout_branch: /^[\w./-]{1,160}$/.test(raw?.checkoutBranch || '') ? raw.checkoutBranch : null,
      original: localAvailable ? localCounts(raw.original) : null,
      reference: localAvailable ? localCounts(raw.reference) : null,
      campaigns: campaigns.status === 'fulfilled' ? campaigns.value : null};
  }

  const listProjects = () => ({default_project_id: list.some(project => project.project_id === defaultProject)
    ? defaultProject : list[0]?.project_id || null, projects: list});

  async function projectReport(projectId, {refresh = false} = {}) {
    const project = list.find(item => item.project_id === projectId);
    if (!project) return null;
    const settings = projects[project.project_id];
    const usesMJobsObserver = !observationReader && projectId === 'mjobs' && settings.localObserver === 'mjobs' &&
      settings.repository.toLowerCase() === 'mulattotech/mjobs';
    const canSync = Boolean(settings.originalPath && settings.referencePath);
    const [published, local, activity, exported] = await Promise.allSettled([
      canSync ? acceptance.read(project.project_id, {refresh}) : null,
      usesMJobsObserver ? localProgress() : null,
      usesMJobsObserver ? desktop.snapshot() : null,
      observationReader ? observationReader(project) : null,
    ]);
    const data = result => result.status === 'fulfilled' && result.value ? result.value : {status: 'UNAVAILABLE'};
    const snapshot = exported.status === 'fulfilled' ? exported.value : null;
    return {project, published_acceptance: data(published),
      local_progress: snapshot?.local_progress || data(local),
      codex_activity: snapshot?.codex_activity || data(activity),
      ...(refresh ? {sync_requested: canSync} : {})};
  }

  async function handle(req, res, {pathname, searchParams, json}) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(405, {error: 'Method not allowed'});
    if (['/mission-control', '/mission-control/', TRACKER.slice(0,-1)].includes(pathname)) {
      res.writeHead(308, {Location: TRACKER});
      return res.end();
    }
    const route = pathname.slice(TRACKER.length);
    if (route === 'api/projects') return json(200, listProjects());
    if (route.startsWith('api/projects/')) {
      const refresh = req.method === 'GET' && searchParams?.get('refresh') === '1';
      const report = await projectReport(route.slice('api/projects/'.length), {refresh});
      return report ? json(200, report) : json(404, {error: 'Unknown tracker project'});
    }
    const asset = ASSETS.get(route);
    if (!asset) return json(404, {error: 'Not found'});
    const bytes = await readFile(path.join(ASSET_ROOT, asset[0]));
    res.writeHead(200, {'Content-Type': asset[1]});
    return res.end(bytes);
  }

  return {handle, listProjects, projectReport};
}

function isTrackerPath(pathname) {
  return pathname === '/mission-control' || pathname === '/mission-control/' ||
    pathname === TRACKER.slice(0,-1) || pathname.startsWith(TRACKER);
}

module.exports = {createFleetTracker, isTrackerPath, readCampaigns, resolvePublicGitHead};
