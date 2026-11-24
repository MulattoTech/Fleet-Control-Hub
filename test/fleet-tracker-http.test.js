'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {makeServer} = require('../src/server');
const {createFleetTracker, readCampaigns, resolvePublicGitHead, createTelemetryReader} = require('../src/fleet-tracker');
const {mkdtemp, writeFile, rm} = require('node:fs/promises');
const path = require('node:path');
const {tmpdir} = require('node:os');

const ROOT = '/mission-control/analytics/';
const MJobs = 'mjobs';
const publishedSha = 'a'.repeat(40);
const localSha = 'b'.repeat(40);
const fixtureTime = '2026-11-23T10:00:00.000Z';

function request(server, path, {host = 'localhost:48724', method = 'GET', token} = {}) {
  return new Promise((resolve, reject) => {
    const headers = token ? {host, 'cf-access-jwt-assertion': token} : {host};
    const req = http.request({hostname: '127.0.0.1', port: server.address().port, path, method, headers}, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({status: response.statusCode, headers: response.headers, body}));
    });
    req.on('error', reject);
    req.end();
  });
}

test('Fleet Tracker opts into the existing owner gate and has read-only project-scoped routes', async () => {
  const reads = [];
  const tracker = createFleetTracker({
    acceptance: {read: async id => {
      reads.push(['published', id]);
      return {status: 'CURRENT', published_commit: publishedSha, original: {pass: 190, total: 366}};
    }},
    mission: {status: async () => ({available: true, observedAt: fixtureTime, checkoutHeadSha: localSha,
      checkoutBranch: 'main', original: {pass: 186, total: 366, partial: 80, notRun: 100},
      reference: {pass: 0, total: 59, partial: 4, notRun: 55}, privateWorkspace: '/private/user/worktree'})},
    desktop: {snapshot: async () => ({status: 'fresh', project_id: MJobs,
      counts: {session_count: 0}, observed_at: fixtureTime})},
    campaignReader: async () => [],
    telemetryReader: async name => name==='analytics.json'?{schemaVersion:1,agents:[],summary:{},generatedAt:fixtureTime}:null,
  });
  const remote = {hostname: 'fleet.fixture.invalid'};
  const server = makeServer({tracker, port: 48724, remote, verifyRemote: async token => {
    if (token !== 'owner-fixture') throw new Error('Denied');
  }});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const api = `${ROOT}api/projects`;
    assert.equal((await request(server, `${api}/${MJobs}`, {host: remote.hostname})).status, 403);
    assert.equal((await request(server, api, {host: 'untrusted.invalid'})).status, 403);
    assert.equal((await request(server, `${api}/${MJobs}`, {method: 'POST'})).status, 405);
    assert.deepEqual(reads, []);
    const alias = await request(server, '/mission-control/');
    assert.equal(alias.status, 308);
    assert.equal(alias.headers.location, ROOT);
    const home = await request(server, '/?project=mjobs');
    assert.equal(home.status, 308);
    assert.equal(home.headers.location, ROOT + '?project=mjobs');
    assert.equal((await request(server, '/controls/')).status, 200);
    const grafana = await request(server, '/mission-control/grafana/');
    assert.equal(grafana.status,308);
    assert.equal(grafana.headers.location,'https://m-techlabs.com/mission-control/grafana/');
    const projects = JSON.parse((await request(server, api)).body).projects;
    assert.deepEqual(projects.map(p => p.project_id), ['babytracker','mjobs']);
    assert.equal((await request(server, `${api}/unknown`)).status, 404);
    const remoteRequest = await request(server, `${api}/${MJobs}`, {host: remote.hostname, token: 'owner-fixture'});
    assert.equal(remoteRequest.status, 200);
    assert.equal(remoteRequest.headers['cache-control'], 'no-store');
    assert.equal(remoteRequest.body.includes('/private/'), false);
    const report = JSON.parse(remoteRequest.body);
    assert.equal(report.published_acceptance.published_commit, publishedSha);
    assert.equal(report.published_acceptance.original.pass, 190);
    assert.equal(report.local_progress.checkout_commit, localSha);
    assert.equal(report.local_progress.original.pass, 186);
    assert.equal(report.local_progress.reference.pass, 0);
    assert.equal(report.codex_activity.counts.session_count, 0);
    const other = JSON.parse((await request(server, `${api}/babytracker`)).body);
    assert.equal(other.local_progress.status, 'UNAVAILABLE');
    assert.equal(other.codex_activity.status, 'UNAVAILABLE');
    assert.deepEqual(reads, [['published', MJobs]]);
    for (const asset of ['', 'atlas.css', 'atlas.js', 'source-status.js']) {
      assert.equal((await request(server, ROOT + asset)).status, 200);
    }
    const telemetry = await request(server, ROOT + 'analytics.json');
    assert.equal(JSON.parse(telemetry.body).generatedAt, fixtureTime, 'a historical sample must retain its timestamp');
    assert.equal((await request(server, ROOT + 'collector-status.json')).status,503);
    assert.equal((await request(server, ROOT + 'analytics.json',{host:remote.hostname})).status,403);
    assert.equal((await request(server, `${ROOT}../../src/server.js`)).status, 404);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('inline telemetry reads only bounded sanitized publication files and never invents live data', async t => {
  const root = await mkdtemp(path.join(tmpdir(),'fleet-telemetry-test-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const reader = createTelemetryReader(root);
  assert.equal(await reader('analytics.json'),null);
  assert.equal(await reader('../private.json'),null);
  await writeFile(path.join(root,'analytics.json'),JSON.stringify({schemaVersion:1,agents:[],summary:{},generatedAt:fixtureTime}));
  assert.equal((await reader('analytics.json')).generatedAt,fixtureTime);
  await writeFile(path.join(root,'analytics.json'),'{}');
  assert.equal(await reader('analytics.json'),null);
  await writeFile(path.join(root,'collector-status.json'),' '.repeat(4097));
  assert.equal(await reader('collector-status.json'),null);
  await writeFile(path.join(root,'collector-status.json'),JSON.stringify({available:false,reasonCode:'COLLECTION_UNAVAILABLE'}));
  assert.equal((await reader('collector-status.json')).available,false);
});

test('repository estimates share the owner gate and reject invalid destinations before reading', async t => {
  const calls = [];
  const tracker = createFleetTracker({repositoryProgress:{read:async (repository, options) => {
    calls.push({repository, ...options});
    return {status:'ESTIMATED', repository, percent:25, total:4, done:1};
  }}});
  const server = makeServer({tracker, port:48724, remote:{hostname:'fleet.fixture.invalid'},
    verifyRemote:async token => {if(token !== 'owner-fixture') throw Error('Denied');}});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = ROOT + 'api/repository-progress';
  const query = '?repository=' + encodeURIComponent('https://github.com/Owner/Example') + '&refresh=1';
  assert.equal((await request(server, endpoint + query, {host:'fleet.fixture.invalid'})).status,403);
  assert.equal((await request(server, endpoint + query, {method:'POST'})).status,405);
  for(const invalid of ['?repository=http://127.0.0.1/private', '?repository=a/b&repository=c/d',
    '?repository=a/b&path=secret', '?repository=a/b&refresh=2', '']) {
    assert.equal((await request(server, endpoint + invalid)).status,400);
  }
  assert.deepEqual(calls,[]);
  const result = await request(server,endpoint + query,{host:'fleet.fixture.invalid',token:'owner-fixture'});
  assert.equal(result.status,200);
  assert.equal(JSON.parse(result.body).status,'ESTIMATED');
  assert.equal(calls.length,1);
  assert.equal(calls[0].repository.toLowerCase(),'owner/example');
  assert.equal(calls[0].refresh,true);
});

test('campaign bridge reports approved fields, keeps zero and drops private decorations', async () => {
  const scoreboard = {total: 60, verified_pass: 0, PARTIAL: 53, NOT_RUN: 7, FAIL: 0, BLOCKED: 0};
  const rows = await readCampaigns(async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:18726/api/progress/campaigns');
    assert.equal(options.redirect, 'error');
    return Response.json({available: true, campaigns: [
      {requirement_id: 'MJ-REQ-292', score: 25, scoreboard, source_revision: localSha,
       updated_at_utc: fixtureTime, next_action: 'private worktree path', blockers: ['unpublished payload']},
      {requirement_id: 'invalid', scoreboard},
    ]});
  });
  assert.deepEqual(rows, [{requirement_id: 'MJ-REQ-292', updated_at_utc: fixtureTime,
    source_revision: localSha, scoreboard}]);
  assert.equal(await readCampaigns(async () => Response.json({available: false})), null);
});

test('public Git ref resolution binds both remote and full branch and disables prompts', async () => {
  const run = async (command, args, options) => {
    assert.equal(command, 'git');
    assert.deepEqual(args.slice(-4), ['--refs', '--exit-code', 'https://github.com/MulattoTech/MJobs.git', 'refs/heads/main']);
    assert.ok(args.includes('credential.helper='));
    assert.equal(options.env.GIT_TERMINAL_PROMPT, '0');
    return {stdout: `${publishedSha}\trefs/heads/main\n`};
  };
  assert.equal(await resolvePublicGitHead({repository: 'MulattoTech/MJobs', branch: 'main'}, run), publishedSha);
  await assert.rejects(resolvePublicGitHead({repository: '../other', branch: 'main'}, run), /INVALID_PROJECT_SOURCE/);
  await assert.rejects(resolvePublicGitHead({repository: 'MulattoTech/MJobs', branch: 'main'},
    async () => ({stdout: `${publishedSha}\trefs/tags/main\n`})), /PUBLISHED_REF_UNAVAILABLE/);
});
