'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPublishedAcceptanceReader } = require('../src/published-acceptance');

const SHA = 'c3a3e74437735fc1c99b9976088d58f5e52175fa';
const project = {
  'mjobs': {
    repository: 'MulattoTech/MJobs',
    branch: 'main',
    originalPath: 'planning/CAPABILITY_MATRIX.json',
    referencePath: 'planning/REFERENCE_GAP_MATRIX.json',
  },
};

function response(body, { status = 200, redirected = false } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected,
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
  };
}

const original = { requirements: [
  { requirement_id: 'REQ-1', result: 'PASS' },
  { requirement_id: 'REQ-2', result: 'PARTIAL' },
  { requirement_id: 'REQ-3', result: 'NOT_RUN' },
] };
const reference = {
  canonical_ids: ['REF-1', 'REF-2'],
  result_by_id: { 'REF-1': { result: 'PASS' }, 'REF-2': 'NOT_RUN' },
};

function matrixFetcher(originalBody = original, referenceBody = reference) {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    if (String(url).includes('/planning/CAPABILITY_MATRIX.json')) return response(originalBody);
    if (String(url).includes('/planning/REFERENCE_GAP_MATRIX.json')) return response(referenceBody);
    throw new Error('Unexpected URL');
  };
  return { fetchImpl, urls };
}

test('reads validated matrices pinned to the resolved published commit', async () => {
  const { fetchImpl, urls } = matrixFetcher();
  const reader = createPublishedAcceptanceReader({
    projects: project,
    fetchImpl,
    resolveCommit: async (configured) => {
      assert.deepEqual(configured, {
        project_id: 'mjobs', repository: 'MulattoTech/MJobs', branch: 'main',
        originalPath: 'planning/CAPABILITY_MATRIX.json',
        referencePath: 'planning/REFERENCE_GAP_MATRIX.json',
        originalSchema: undefined, referenceSchema: undefined,
        originalIdField: 'requirement_id', originalResultField: 'result',
      });
      return SHA;
    },
    now: () => new Date('2026-11-23T18:00:00.000Z'),
  });

  const result = await reader.read('mjobs');
  assert.equal(result.project_id, 'mjobs');
  assert.equal(result.repository, 'MulattoTech/MJobs');
  assert.equal(result.branch, 'main');
  assert.equal(result.published_commit, SHA);
  assert.equal(result.last_success_at, '2026-11-23T18:00:00.000Z');
  assert.equal(result.status, 'CURRENT');
  assert.deepEqual(result.original, { pass: 1, partial: 1, not_run: 1, total: 3 });
  assert.deepEqual(result.reference, { pass: 1, partial: 0, not_run: 1, total: 2 });
  assert.deepEqual(result.requirements.map(row=>[row.id,row.status]),
    [['REQ-1','PASS'],['REQ-2','PARTIAL'],['REQ-3','NOT_RUN']]);
  assert.equal(urls.length, 2);
  assert.ok(urls.every((url) => url.startsWith(`https://raw.githubusercontent.com/MulattoTech/MJobs/${SHA}/`)));
});

test('preserves legitimate zero counts', async () => {
  const { fetchImpl } = matrixFetcher({ requirements: [] }, { canonical_ids: [], result_by_id: {} });
  const reader = createPublishedAcceptanceReader({
    projects: project, fetchImpl, resolveCommit: async () => SHA,
  });
  const result = await reader.read('mjobs');
  assert.equal(result.status, 'CURRENT');
  assert.deepEqual(result.original, { pass: 0, partial: 0, not_run: 0, total: 0 });
  assert.deepEqual(result.reference, { pass: 0, partial: 0, not_run: 0, total: 0 });
});

test('returns unavailable without fabricating zeroes when the first sync fails', async () => {
  const reader = createPublishedAcceptanceReader({
    projects: project,
    fetchImpl: async () => response({}, { status: 503 }),
    resolveCommit: async () => SHA,
  });
  const result = await reader.read('mjobs');
  assert.equal(result.status, 'UNAVAILABLE');
  assert.equal(result.repository, 'MulattoTech/MJobs');
  assert.equal(result.branch, 'main');
  assert.equal(result.published_commit, null);
  assert.equal(result.last_success_at, null);
  assert.equal(result.original, null);
  assert.equal(result.reference, null);
  assert.equal(result.reason, 'published_sync_failed');
});

test('default commit resolution uses the fixed GitHub API and pins both blobs to its SHA', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    if (String(url).startsWith('https://api.github.com/')) return response({ sha: SHA });
    if (String(url).includes('/planning/CAPABILITY_MATRIX.json')) return response(original);
    if (String(url).includes('/planning/REFERENCE_GAP_MATRIX.json')) return response(reference);
    throw new Error('Unexpected URL');
  };
  const reader = createPublishedAcceptanceReader({ projects: project, fetchImpl });
  const result = await reader.read('mjobs');
  assert.equal(result.status, 'CURRENT');
  assert.equal(urls[0], 'https://api.github.com/repos/MulattoTech/MJobs/commits/main');
  assert.ok(urls.slice(1).every((url) => url.includes(`/${SHA}/`)));
});

test('reuses a fresh successful snapshot and attempts a sync after max age expires', async () => {
  let current = new Date('2026-11-23T18:00:00.000Z');
  let blobFetches = 0;
  const { fetchImpl } = matrixFetcher();
  const reader = createPublishedAcceptanceReader({
    projects: project,
    fetchImpl: async (...args) => { blobFetches += 1; return fetchImpl(...args); },
    resolveCommit: async () => SHA,
    now: () => current,
    maxAgeMs: 100,
  });

  const first = await reader.read('mjobs');
  current = new Date(current.getTime() + 99);
  const cached = await reader.read('mjobs');
  assert.equal(blobFetches, 2);
  assert.equal(cached.last_success_at, first.last_success_at);
  assert.equal(cached.status, 'CURRENT');

  current = new Date(current.getTime() + 1);
  await reader.read('mjobs');
  assert.equal(blobFetches, 4);
});

test('explicit refresh bypasses fresh TTL and failed forced refresh remains stale during bounded backoff', async () => {
  let current = new Date('2026-11-23T18:00:00.000Z');
  let fail = false;
  let blobFetches = 0;
  const { fetchImpl } = matrixFetcher();
  const reader = createPublishedAcceptanceReader({
    projects: project,
    fetchImpl: async (...args) => {
      blobFetches += 1;
      return fail ? response({}, { status: 503 }) : fetchImpl(...args);
    },
    resolveCommit: async () => SHA,
    now: () => current,
    maxAgeMs: 60_000,
  });

  const first = await reader.read('mjobs');
  const refreshed = await reader.read('mjobs', { refresh: true });
  assert.equal(blobFetches, 4);
  assert.equal(refreshed.status, 'CURRENT');
  assert.equal(refreshed.last_success_at, first.last_success_at);

  fail = true;
  current = new Date(current.getTime() + 1_000);
  const forcedFailure = await reader.read('mjobs', { refresh: true });
  assert.equal(blobFetches, 6);
  assert.equal(forcedFailure.status, 'STALE');
  assert.equal(forcedFailure.published_commit, first.published_commit);
  assert.equal(forcedFailure.last_success_at, first.last_success_at);
  assert.equal(forcedFailure.checked_at, '2026-11-23T18:00:01.000Z');

  const backoffRead = await reader.read('mjobs');
  assert.equal(blobFetches, 6);
  assert.equal(backoffRead.status, 'STALE');
  assert.equal(backoffRead.checked_at, forcedFailure.checked_at);

  current = new Date(current.getTime() + 14_999);
  await reader.read('mjobs');
  assert.equal(blobFetches, 6);
  current = new Date(current.getTime() + 1);
  const retry = await reader.read('mjobs');
  assert.equal(blobFetches, 8);
  assert.equal(retry.status, 'STALE');
  assert.equal(retry.last_success_at, first.last_success_at);
  assert.equal(retry.checked_at, '2026-11-23T18:00:16.000Z');
});

test('failed forced check without a snapshot stays unavailable during backoff; force remains available', async () => {
  let fetches = 0;
  let current = new Date('2026-11-23T18:00:00.000Z');
  const reader = createPublishedAcceptanceReader({
    projects: project,
    fetchImpl: async () => { fetches += 1; return response({}, { status: 503 }); },
    resolveCommit: async () => SHA,
    now: () => current,
    maxAgeMs: 10_000,
  });

  const forced = await reader.read('mjobs', { refresh: true });
  assert.equal(forced.status, 'UNAVAILABLE');
  assert.equal(fetches, 2);
  const normal = await reader.read('mjobs');
  assert.equal(normal.status, 'UNAVAILABLE');
  assert.equal(normal.checked_at, forced.checked_at);
  assert.equal(fetches, 2);
  const forcedAgain = await reader.read('mjobs', { refresh: true });
  assert.equal(forcedAgain.status, 'UNAVAILABLE');
  assert.equal(fetches, 4);

  current = new Date(current.getTime() + 10_000);
  const timedRetry = await reader.read('mjobs');
  assert.equal(timedRetry.status, 'UNAVAILABLE');
  assert.equal(fetches, 6);
});

test('deduplicates concurrent syncs for the same project', async () => {
  let resolveGate;
  const gate = new Promise((resolve) => { resolveGate = resolve; });
  let commitCalls = 0;
  let blobFetches = 0;
  const { fetchImpl } = matrixFetcher();
  const reader = createPublishedAcceptanceReader({
    projects: project,
    fetchImpl: async (...args) => { blobFetches += 1; return fetchImpl(...args); },
    resolveCommit: async () => { commitCalls += 1; await gate; return SHA; },
    maxAgeMs: 0,
  });

  const first = reader.read('mjobs');
  const second = reader.read('mjobs');
  resolveGate();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  assert.equal(commitCalls, 1);
  assert.equal(blobFetches, 2);
});

test('retains the last verified snapshot as stale after a failed refresh', async () => {
  let fail = false;
  const { fetchImpl } = matrixFetcher();
  const reader = createPublishedAcceptanceReader({
    projects: project,
    fetchImpl: async (url, options) => fail ? response({}, { status: 503 }) : fetchImpl(url, options),
    resolveCommit: async () => SHA,
    maxAgeMs: 0,
    now: () => new Date('2026-11-23T18:00:00.000Z'),
  });

  const first = await reader.read('mjobs');
  fail = true;
  const second = await reader.read('mjobs');
  assert.equal(second.status, 'STALE');
  assert.equal(second.published_commit, first.published_commit);
  assert.equal(second.last_success_at, first.last_success_at);
  assert.deepEqual(second.original, first.original);
  assert.equal(second.reason, 'published_sync_failed_previous_snapshot_retained');
});

test('malformed data is unavailable and cannot replace a verified snapshot', async () => {
  let malformed = false;
  const { fetchImpl } = matrixFetcher();
  const reader = createPublishedAcceptanceReader({
    projects: project,
    fetchImpl: async (url, options) => {
      if (malformed && String(url).includes('/planning/CAPABILITY_MATRIX.json')) {
        return response({ requirements: [{ requirement_id: 'REQ-1', result: 'SUCCESS' }] });
      }
      return fetchImpl(url, options);
    },
    resolveCommit: async () => SHA,
    maxAgeMs: 0,
  });
  const first = await reader.read('mjobs');
  malformed = true;
  const second = await reader.read('mjobs');
  assert.equal(second.status, 'STALE');
  assert.equal(second.reason, 'published_data_invalid_previous_snapshot_retained');
  assert.deepEqual(second.original, first.original);
});

test('rejects unconfigured projects and unsafe repository or path configuration', async () => {
  const reader = createPublishedAcceptanceReader({ projects: project, fetchImpl: async () => response({}) });
  await assert.rejects(reader.read('other'), /Project is not configured/);
  const unsafe = createPublishedAcceptanceReader({
    projects: { x: { repository: 'https://example.com/owner/repo', branch: 'main', originalPath: '../matrix.json', referencePath: 'refs.json' } },
    fetchImpl: async () => response({}),
  });
  await assert.rejects(unsafe.read('x'), /Project configuration is invalid/);
});

test('does not follow redirects from GitHub endpoints', async () => {
  const reader = createPublishedAcceptanceReader({
    projects: project,
    fetchImpl: async () => response({}, { status: 302, redirected: true }),
  });
  const result = await reader.read('mjobs');
  assert.equal(result.status, 'UNAVAILABLE');
  assert.equal(result.reason, 'published_sync_failed');
});
