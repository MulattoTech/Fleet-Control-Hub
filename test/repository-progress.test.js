'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createRepositoryProgressReader, normalizeRepository } = require('../src/repository-progress');

const repo = 'octo/project';
const sha = 'a'.repeat(40);
const response = (status, value, headers = {}) => ({
  status, ok: status >= 200 && status < 300,
  headers: { get: name => headers[name.toLowerCase()] ?? null },
  text: async () => value
});
const json = value => JSON.stringify(value);
const progress = { schema_version: 1, goals: [
  { id: 'one', title: 'One', status: 'done' },
  { id: 'two', title: 'Two', status: 'in_progress' },
  { id: 'three', title: 'Three', status: 'not_started' },
  { id: 'four', title: 'Four', status: 'blocked' }
] };
function fetchFor({ manifest = response(200, json(progress)), readme = response(404, '') } = {}) {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/repos/octo/project/commits/')) return response(200, json({ sha }));
    if (String(url).endsWith('/repos/octo/project')) return response(200, json({ default_branch: 'main' }));
    if (String(url).includes('/.fleet/progress.json')) return manifest;
    if (String(url).includes('/README.md')) return readme;
    throw new Error('unexpected URL');
  };
  return { calls, fetcher };
}

test('normalizes owner/name and only exact public GitHub repository URLs', () => {
  assert.deepEqual(normalizeRepository('octo/project'), { owner: 'octo', name: 'project', key: 'octo/project' });
  assert.equal(normalizeRepository('https://github.com/octo/project.git/').key, 'octo/project');
  for (const bad of ['http://github.com/a/b', 'https://github.com.evil/a/b', 'https://user@github.com/a/b',
    'https://github.com/a/b?x=1', 'https://github.com/a/b#x', 'https://github.com/a/b/tree/main',
    '../a/b', 'https://raw.githubusercontent.com/a/b']) assert.throws(() => normalizeRepository(bad));
});

test('reads goals at the resolved exact commit and reports an estimate', async () => {
  const { fetcher, calls } = fetchFor();
  const result = await createRepositoryProgressReader({ fetcher, clock: () => 1000 }).read(repo);
  assert.deepEqual([result.status, result.repository, result.branch, result.commit], ['ESTIMATED', repo, 'main', sha]);
  assert.deepEqual([result.total, result.done, result.in_progress, result.not_started, result.blocked, result.percent], [4, 1, 1, 1, 1, 25]);
  assert.equal(result.method, 'manifest');
  assert.equal(result.source_path, '.fleet/progress.json');
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.options.redirect === 'error' && call.options.signal));
  assert.ok(calls[2].url.endsWith(`/${sha}/.fleet/progress.json`));
});

test('rejects malformed manifests without falling back to the README', async () => {
  for (const goals of [[], [{ id: 'x', title: 'X', status: 'done' }, { id: 'x', title: 'Y', status: 'done' }],
    [{ id: 'x', title: 'X', status: 'complete' }], [{ id: 'x', title: 'x'.repeat(501), status: 'done' }]]) {
    const { fetcher, calls } = fetchFor({ manifest: response(200, json({ schema_version: 1, goals })),
      readme: response(200, '- [x] should not be used') });
    const result = await createRepositoryProgressReader({ fetcher }).read(repo);
    assert.equal(result.status, 'UNAVAILABLE');
    assert.equal(result.total, null);
    assert.equal(result.reason, 'invalid_manifest');
    assert.equal(calls.length, 3);
  }
});

test('uses a labeled checklist estimate only when the manifest is absent', async () => {
  const { fetcher } = fetchFor({ manifest: response(404, ''), readme: response(200, '# Tasks\n- [x] Ship\n- [ ] Review\n') });
  const result = await createRepositoryProgressReader({ fetcher }).read(repo);
  assert.deepEqual([result.status, result.method, result.total, result.done, result.percent], ['ESTIMATED', 'estimated_checklist_completion', 2, 1, 50]);
  for (const readme of [response(404, ''), response(200, 'No goals here')]) {
    const other = fetchFor({ manifest: response(404, ''), readme });
    const unavailable = await createRepositoryProgressReader({ fetcher: other.fetcher }).read(repo);
    assert.equal(unavailable.status, 'UNAVAILABLE');
    assert.equal(unavailable.percent, null);
  }
});

test('bounds file size, request time and total request count', async () => {
  const tooBig = fetchFor({ manifest: response(200, 'x'.repeat(200_001)) });
  assert.equal((await createRepositoryProgressReader({ fetcher: tooBig.fetcher }).read(repo)).reason, 'response_too_large');
  const streaming = fetchFor({ manifest: { ...response(200, ''), body: { getReader: () => {
    let sent = false;
    return { read: async () => sent ? { done: true } : (sent = true, { done: false, value: new Uint8Array(150_000) }),
      cancel: async () => {}, releaseLock() {} };
  } } } });
  assert.equal((await createRepositoryProgressReader({ fetcher: streaming.fetcher }).read(repo)).reason, 'response_too_large');
  const slow = fetchFor();
  const timed = createRepositoryProgressReader({ timeoutMs: 10, fetcher: async (...args) => {
    await new Promise(resolve => setTimeout(resolve, 25)); return slow.fetcher(...args);
  } });
  assert.equal((await timed.read(repo)).status, 'UNAVAILABLE');
  assert.equal((await timed.read(repo)).reason, 'request_timeout');
  assert.equal(tooBig.calls.length, 3);
});

test('evicts the least recently used repository from the bounded cache', async () => {
  let calls = 0;
  const fetcher = async (url, options) => {
    calls++;
    const rewritten = String(url).replaceAll('/octo/project', '/octo/other');
    return fetchFor().fetcher(rewritten, options);
  };
  const reader = createRepositoryProgressReader({ fetcher, maxCacheEntries: 1 });
  await reader.read('octo/project'); const afterFirst = calls;
  await reader.read('octo/other');
  await reader.read('octo/project');
  assert.equal(calls, afterFirst * 3);
});

test('bounds the whole read deadline and global in-flight work', async () => {
  const base = fetchFor();
  const slowFetcher = async (...args) => {
    await new Promise(resolve => setTimeout(resolve, 8));
    return base.fetcher(...args);
  };
  const started = Date.now();
  const limited = createRepositoryProgressReader({ fetcher: slowFetcher, timeoutMs: 1000, totalTimeoutMs: 12 });
  assert.equal((await limited.read(repo)).reason, 'request_timeout');
  assert.ok(Date.now() - started < 200, 'the complete read stops at its small configured deadline');

  let release;
  const held = new Promise(resolve => { release = resolve; });
  const concurrent = createRepositoryProgressReader({ maxConcurrentReads: 1, fetcher: async (...args) => {
    await held; return base.fetcher(...args);
  } });
  const first = concurrent.read(repo);
  await new Promise(resolve => setTimeout(resolve, 2));
  const second = await concurrent.read('octo/other');
  assert.equal(second.reason, 'reader_busy');
  release(); await first;
});

test('caches and singleflights reads, and returns stale estimates after refresh failure', async () => {
  let now = 1000; let fail = false; let count = 0;
  const { fetcher: base } = fetchFor();
  const fetcher = async (...args) => { count++; if (fail) return response(503, 'private upstream detail'); return base(...args); };
  const reader = createRepositoryProgressReader({ fetcher, clock: () => now, cacheTtlMs: 100 });
  const [a, b] = await Promise.all([reader.read(repo), reader.read(repo)]);
  assert.deepEqual(a, b); assert.equal(count, 3);
  assert.deepEqual(await reader.read(repo), a); assert.equal(count, 3);
  now += 101; fail = true;
  const stale = await reader.read(repo, { refresh: true });
  assert.equal(stale.status, 'STALE'); assert.equal(stale.total, 4); assert.equal(stale.reason, 'upstream_unavailable');
});

test('preserves rate-limit meaning and never returns upstream body text', async () => {
  const { fetcher: base } = fetchFor();
  const reader = createRepositoryProgressReader({ fetcher: async (url, options) => String(url).endsWith('/repos/octo/project')
    ? response(403, 'SECRET body', { 'x-ratelimit-remaining': '0' }) : base(url, options) });
  const result = await reader.read(repo);
  assert.equal(result.reason, 'rate_limited');
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
});
