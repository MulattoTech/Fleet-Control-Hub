'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createGitHubDelivery } = require('../src/github-delivery');
const { makeServer } = require('../src/server');

const pr = (number, draft = false) => ({ number, draft, state: 'open' });

test('GitHub delivery reports open, draft and merged counts without acceptance inference', async () => {
  const calls = [];
  let now = Date.UTC(2026, 10, 9, 18, 0);
  const fetcher = async url => {
    calls.push(url);
    return { ok: true, json: async () => url.includes('/search/issues')
      ? { total_count: 76 }
      : [pr(1001), pr(1000, true), pr(999)] };
  };
  const source = createGitHubDelivery({ fetcher, clock: () => now });
  const first = await source.status();
  assert.deepEqual([first.openTotal, first.openDrafts, first.mergedSince], [3, 1, 76]);
  assert.equal(first.sinceUTC, '2026-11-02');
  assert.equal(first.available, true);
  assert.equal('accepted' in first, false);
  assert.ok(calls.some(url => url.includes('state=open')));
  assert.ok(calls.some(url => decodeURIComponent(url).includes('merged:>=2026-11-02')));
  now += 30000;
  assert.deepEqual(await source.status(), first);
  assert.equal(calls.length, 2, 'status reads use the bounded cache');
});

test('GitHub delivery paginates and counts drafts without inventing totals', async () => {
  const calls = [];
  const fetcher = async url => {
    calls.push(url);
    const result = url.includes('/search/') ? { total_count: 8 }
      : url.endsWith('&page=1') ? Array.from({ length: 100 }, (_, i) => pr(i + 1, i < 3))
      : [pr(101)];
    return { ok: true, json: async () => result };
  };
  const result = await createGitHubDelivery({ fetcher }).status();
  assert.equal(result.openTotal, 101);
  assert.equal(result.openDrafts, 3);
  assert.equal(calls.length, 3);
});

test('GitHub delivery fails closed on API error and malformed PR data', async () => {
  for (const fetcher of [
    async () => ({ ok: false, status: 403 }),
    async url => ({ ok: true, json: async () => url.includes('/search/')
      ? { total_count: 10 } : [{ number: 1000, draft: false, state: 'closed' }] })
  ]) {
    const result = await createGitHubDelivery({ fetcher }).status();
    assert.equal(result.available, false);
    assert.equal(result.openTotal, undefined);
    assert.match(result.reason, /no counts are inferred/);
  }
});

test('GitHub delivery de-duplicates concurrent refreshes', async () => {
  let calls = 0;
  const fetcher = async url => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 10));
    return { ok: true, json: async () => url.includes('/search/') ? { total_count: 5 } : [] };
  };
  const source = createGitHubDelivery({ fetcher });
  const [a, b] = await Promise.all([source.status(), source.status()]);
  assert.deepEqual(a, b);
  assert.equal(calls, 2);
});

test('delivery HTTP route is read-only and obeys the hub Host boundary', async t => {
  const probe = require('node:net').createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const server = makeServer({
    port,
    delivery: { status: async () => ({ available: true, openTotal: 41, openDrafts: 1, mergedSince: 76, sinceUTC: '2026-11-02' }) },
    remote: null
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const ok = await fetch('http://127.0.0.1:' + port + '/api/delivery');
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).openTotal, 41);
  const denied = await new Promise((resolve, reject) => {
    const req = require('node:http').get({
      host: '127.0.0.1', port, path: '/api/delivery',
      headers: { Host: 'untrusted.example' }
    }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
  });
  assert.equal(denied, 403);
});

test('Fleet overview separates development delivery from canonical release acceptance', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const ui = fs.readFileSync(path.join(__dirname, '../public/workspace.js'), 'utf8');
  assert.match(html, /id="development-delivery"/);
  assert.match(html, /id="delivery-metrics"/);
  assert.match(html, /id="mission-metrics"/);
  assert.match(ui, /fetch\('\/api\/delivery'/);
  assert.match(ui, /Merged since/);
  assert.match(ui, /canonical acceptance remains separate/);
});
