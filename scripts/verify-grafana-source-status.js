'use strict';
// Opt-in read-only runtime verification. Posts datasource QUERIES only; it never
// saves a dashboard, changes credentials, writes telemetry, or starts agents.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const base = 'http://127.0.0.1:18731/mission-control/grafana';
const source = JSON.parse(fs.readFileSync(path.join(__dirname,
  '../packages/mjobs-controller/observability/dashboards/fleet-atlas.json'), 'utf8'));
const panel = source.panels.find(item => item.id === 20);
const target = panel.targets[0];
assert.equal(target.url, 'http://fleet-analytics-data:8080/collector-status.json');
assert.equal(target.url_options.method, 'GET');
assert.equal(target.parser, 'backend');
assert.ok(process.argv.slice(2).every(arg => arg === '--deployed'), 'Only --deployed is supported');

async function readJson(route, options = {}) {
  const reply = await fetch(base + route, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!reply.ok) throw Error('Grafana verification HTTP ' + reply.status + ' at ' + route);
  return reply.json();
}

function values(result) {
  assert.equal(result?.status, 200, 'Datasource query must complete successfully');
  assert.ok(!result.error, 'Datasource query returned an error');
  const frame = result.frames?.[0];
  const column = frame?.schema?.fields?.findIndex(field => field.name === 'Source status');
  return column >= 0 ? frame.data.values[column] : [];
}

async function main() {
  if (process.argv.includes('--deployed')) {
    const live = (await readJson('/api/dashboards/uid/fleet-atlas')).dashboard.panels.find(item => item.id === 20);
    for (const field of ['url', 'source', 'parser', 'type']) {
      assert.equal(live.targets[0][field], target[field], 'Deployed target ' + field + ' must match source');
    }
    assert.deepEqual(live.targets[0].url_options, target.url_options, 'Deployed request method/options must match source');
    assert.deepEqual(live.targets[0].datasource, target.datasource, 'Deployed datasource must match source');
    assert.equal(live.targets[0].root_selector, target.root_selector, 'Deployed selector must match source');
    assert.deepEqual(live.targets[0].columns, target.columns, 'Deployed columns must match source');
    assert.deepEqual(live.fieldConfig.overrides, panel.fieldConfig.overrides, 'Deployed labels must match source');
  }
  const now = Date.now(), current = new Date(now).toISOString(), old = new Date(now - 86400000).toISOString();
  const good = { schemaVersion: 1, staleAfterSeconds: 90, checkedAt: current, available: true,
    reasonCode: 'OK', message: 'Synthetic verification receipt', lastSuccessAt: current };
  const cases = [
    ['healthy', good, ['true']],
    ['offline-history', { ...good, available: false, reasonCode: 'NATIVE_ROSTER_OFFLINE', lastSuccessAt: old }, ['false']],
    ['stale-check', { ...good, checkedAt: old }, []],
    ['stale-success', { ...good, lastSuccessAt: old }, []],
    ['nonboolean', { ...good, available: 'true' }, []],
    ['wrong-success-code', { ...good, reasonCode: 'COLLECTION_UNAVAILABLE' }, []],
    ['unsupported-schema', { ...good, schemaVersion: 2 }, []],
    ['future-check', { ...good, checkedAt: new Date(now + 60000).toISOString() }, []],
  ];
  const query = { ...target, intervalMs: 30000, maxDataPoints: 100 };
  const queries = [{ ...query, refId: 'L' }, ...cases.map(([, data], index) => ({
    ...query, refId: String.fromCharCode(65 + index), source: 'inline', url: '', data: JSON.stringify(data),
  }))];
  const reply = await readJson('/api/ds/query', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: String(now - 86400000), to: String(now), queries }) });
  const actual = values(reply.results.L);
  assert.ok(actual.length <= 1, 'Actual status source must contain at most one receipt');
  assert.ok(actual.every(value => value === 'true' || value === 'false'), 'Actual source value must be boolean or absent');
  for (const [index, [name, , expected]] of cases.entries()) {
    assert.deepEqual(values(reply.results[String.fromCharCode(65 + index)]), expected, name);
  }
  console.log(JSON.stringify({ ok: true, deployedSourceMatched: process.argv.includes('--deployed'),
    actualSourceRows: actual.length, actualAvailability: actual[0] ?? null, syntheticCasesPassed: cases.length,
    persistedChanges: false, agentWorkRequested: false }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
