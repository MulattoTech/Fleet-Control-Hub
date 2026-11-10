'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createMJobsDevelopment, parseRecord, summarize, recordHistorySnapshot, buildHistoryDeltas } = require('../src/mjobs-development');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-mjobs-development-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'planning'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'PROGRESS_CARD.json'), JSON.stringify({
    schema_version: 1,
    original: { pass: 183, total: 366, as_of: '2026-11-03T05:59:31.437084+00:00' }
  }));
  fs.writeFileSync(path.join(root, 'planning', 'REQUIREMENT_INDEX.json'), JSON.stringify({
    schema_version: 1,
    requirements: [
      { id: 'MJ-REQ-292', issue: 293, priority: 'P1', area: 'operations_ux_ci', status: 'PARTIAL' },
      { id: 'MJ-REQ-008', issue: 9, priority: 'P0', area: 'orchestration_data_security', status: 'PASS' },
      { id: 'MJ-REF-036', issue: 406, priority: 'P4', area: 'untriaged', status: 'NOT_RUN' }
    ]
  }));
  return root;
}

test('parseRecord distinguishes explicit Requirement trailers from incidental mentions', () => {
  const record = [
    'a'.repeat(40),
    '2026-11-09T21:00:00Z',
    'feat: improve MJ-REQ-008 display',
    'Refs MJ-REF-036\nRequirement: MJ-REQ-292 / #293\nValidation: 22 tests PASS'
  ].join('\x1f');
  const parsed = parseRecord('\r\n' + record);
  assert.deepEqual(parsed.confirmed, ['MJ-REQ-292']);
  assert.deepEqual(new Set(parsed.suggested), new Set(['MJ-REQ-008', 'MJ-REF-036']));
  assert.match(parsed.validation, /PASS/);
});

test('summarize keeps activity, implementation evidence, validation and acceptance separate', () => {
  const index = new Map([
    ['MJ-REQ-292', { status: 'PARTIAL', issue: 293, priority: 'P1', area: 'operations_ux_ci' }],
    ['MJ-REQ-008', { status: 'PASS', issue: 9, priority: 'P0', area: 'orchestration_data_security' }],
    ['MJ-REF-036', { status: 'NOT_RUN', issue: 406, priority: 'P4', area: 'untriaged' }]
  ]);
  const observed = Date.parse('2026-11-10T03:00:00Z');
  const commits = [
    {
      sha: '1'.repeat(40), committedAt: '2026-11-09T21:00:00Z', subject: 'feat one',
      confirmed: ['MJ-REQ-292'], suggested: [], validation: '22 tests PASS', merge: false
    },
    {
      sha: '2'.repeat(40), committedAt: '2026-11-09T20:00:00Z', subject: 'Merge pull request #99',
      confirmed: ['MJ-REQ-008'], suggested: ['MJ-REF-036'], validation: 'exact-head CI PASS', merge: true
    },
    {
      sha: '3'.repeat(40), committedAt: '2026-11-04T20:00:00Z', subject: 'docs',
      confirmed: [], suggested: [], validation: '', merge: false
    }
  ];
  const result = summarize(commits, index, { asOf: '2026-11-03T05:59:31Z', pass: 183, total: 366 }, observed);
  assert.equal(result.commitsSinceCheckpoint, 3);
  assert.equal(result.mergeCommitsSinceCheckpoint, 1);
  assert.equal(result.activityWindows.hour.commits, 0);
  assert.equal(result.activityWindows.day.commits, 2);
  assert.equal(result.activityWindows.day.requirementsWithIntegratedWork, 2);
  assert.equal(result.activityWindows.day.requirementsWithValidatedWork, 2);
  assert.equal(result.activityWindows.week.commits, 3);
  assert.equal(result.confirmedRequirementMappings, 2);
  assert.equal(result.validatedRequirementMappings, 2);
  assert.equal(result.linkedNotAccepted, 1);
  assert.equal(result.mappingStatus.PASS, 1);
  assert.equal(result.mappingStatus.PARTIAL, 1);
  assert.equal(result.suggestedRequirementMappings, 1);
  assert.equal(result.unmappedCommits, 1);
});

test('development source reads bounded local evidence and does not mutate acceptance', async t => {
  const root = fixture(t);
  const log = [
    ['a'.repeat(40), '2026-11-09T21:00:00Z', 'feat mission', 'Requirement: MJ-REQ-292\nValidation: 44 tests PASS'].join('\x1f'),
    ['b'.repeat(40), '2026-11-09T20:00:00Z', 'docs only', 'Validation: git diff --check PASS'].join('\x1f')
  ].join('\x1e') + '\x1e';
  const calls = [];
  const source = createMJobsDevelopment({
    root,
    clock: () => Date.parse('2026-11-10T03:00:00Z'),
    historyFile: path.join(root, 'development-history.json'),
    runGit: async args => {
      calls.push(args);
      if (args[0] === 'rev-parse') return 'c'.repeat(40) + '\n';
      if (args[0] === 'rev-list') return '321\n';
      if (args[0] === 'log') return log;
      throw Error('unexpected git call');
    }
  });
  const result = await source.status();
  assert.equal(result.available, true);
  assert.equal(result.mainSha, 'c'.repeat(40));
  assert.equal(result.mainCommitCount, 321);
  assert.equal(result.confirmedRequirementMappings, 1);
  assert.equal(result.linkedNotAccepted, 1);
  assert.equal(result.checkpoint.pass, 183);
  assert.equal(result.checkpoint.total, 366);
  assert.equal(result.history.available, true);
  assert.equal(result.history.sampleCount, 1);
  assert.equal(result.observedDeltas.day.available, false);
  assert.ok(calls.some(args => args[0] === 'log' && args.some(x => String(x).startsWith('--since='))));
});

test('durable development history stores sanitized counters and computes observed deltas', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-development-history-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'history.json');
  const firstMs = Date.parse('2026-11-10T02:00:00Z');
  const secondMs = Date.parse('2026-11-10T03:00:00Z');
  const first = {
    observedAt: new Date(firstMs).toISOString(),
    mainSha: 'a'.repeat(40),
    mainCommitCount: 100,
    checkpoint: { asOf: '2026-11-03T05:59:31Z', pass: 183, total: 366 },
    commitsSinceCheckpoint: 10,
    mergeCommitsSinceCheckpoint: 2,
    confirmedRequirementMappings: 4,
    validatedRequirementMappings: 3,
    linkedNotAccepted: 2,
    unmappedCommits: 3,
    requirements: [{ id: 'MJ-REQ-292', subject: 'private detail' }]
  };
  const firstHistory = recordHistorySnapshot(file, first, firstMs, 0);
  assert.equal(firstHistory.metadata.sampleCount, 1);

  const second = {
    ...first,
    observedAt: new Date(secondMs).toISOString(),
    mainSha: 'b'.repeat(40),
    mainCommitCount: 102,
    checkpoint: { asOf: '2026-11-03T05:59:31Z', pass: 184, total: 366 },
    commitsSinceCheckpoint: 12,
    mergeCommitsSinceCheckpoint: 3,
    confirmedRequirementMappings: 6,
    validatedRequirementMappings: 5,
    linkedNotAccepted: 3,
    unmappedCommits: 4
  };
  const secondHistory = recordHistorySnapshot(file, second, secondMs, 0);
  const deltas = buildHistoryDeltas(secondHistory.snapshots, second, secondMs);
  assert.equal(secondHistory.metadata.sampleCount, 2);
  assert.equal(deltas.hour.available, true);
  assert.equal(deltas.hour.mainCommitDelta, 2);
  assert.equal(deltas.hour.acceptancePassDelta, 1);
  assert.equal(deltas.hour.requirementMappingsDelta, 2);
  assert.equal(deltas.hour.validatedMappingsDelta, 2);

  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(raw.includes('private detail'), false);
  assert.equal(raw.includes('requirements'), false);
  const stored = JSON.parse(raw);
  assert.deepEqual(Object.keys(stored.snapshots[0]).sort(), [
    'acceptancePass','acceptanceTotal','checkpointAsOf','commitsSinceCheckpoint',
    'confirmedRequirementMappings','linkedNotAccepted','mainCommitCount','mainSha',
    'mergeCommitsSinceCheckpoint','observedAt','unmappedCommits','validatedRequirementMappings'
  ].sort());
});

test('development source fails closed when local evidence is unavailable', async t => {
  const root = fixture(t);
  fs.rmSync(path.join(root, 'planning', 'REQUIREMENT_INDEX.json'));
  const source = createMJobsDevelopment({ root, runGit: async () => 'x' });
  const result = await source.status();
  assert.equal(result.available, false);
  assert.equal(result.commitsSinceCheckpoint, undefined);
  assert.match(result.reason, /no implementation counts are inferred/i);
});


test('development HTTP route is read-only and dashboard renders it separately from acceptance', async t => {
  const { makeServer } = require('../src/server');
  const net = require('node:net');
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const development = {
    status: async () => ({
      available: true,
      observedAt: '2026-11-10T03:00:00Z',
      mainSha: 'd'.repeat(40),
      checkpoint: { asOf: '2026-11-03T05:59:31Z', pass: 183, total: 366 },
      commitsSinceCheckpoint: 100,
      commitsLast24h: 20,
      mergeCommitsSinceCheckpoint: 10,
      confirmedRequirementMappings: 12,
      validatedRequirementMappings: 9,
      linkedNotAccepted: 7,
      unmappedCommits: 61,
      mappingStatus: { PASS: 5, PARTIAL: 4, NOT_RUN: 3, UNKNOWN: 0 }
    })
  };
  const server = makeServer({ port, development, remote: null });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch('http://127.0.0.1:' + port + '/api/development');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.checkpoint.pass, 183);
  assert.equal(body.confirmedRequirementMappings, 12);

  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const ui = fs.readFileSync(path.join(__dirname, '../public/workspace.js'), 'utf8');
  assert.match(html, /Development progress/);
  assert.match(html, /implementation-metrics/);
  assert.match(ui, /fetch\('\/api\/development'/);
  assert.match(ui, /activityWindows/);
  assert.match(ui, /Observed 24h delta/);
  assert.match(ui, /Linked but not formally accepted/);
  assert.match(ui, /acceptance has not automatically moved/);
});
