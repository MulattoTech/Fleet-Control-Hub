'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, 'public/run-ui.js'), 'utf8');
const idle = { projectId: 'mjobs-luna', phase: 'paused', active: false, running: false, quota: { fresh: true, remainingPercent: 80 } };
const response = value => ({ ok: true, json: async () => value });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture(handler) {
  const elements = new Map(), storage = new Map(), calls = [], timers = [];
  const element = id => { if (!elements.has(id)) elements.set(id, { textContent: '', disabled: false, classList: { add() {} }, addEventListener(type, fn) { this[type] = fn; } }); return elements.get(id); };
  const context = vm.createContext({
    document: { getElementById: element }, sessionStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    fetch: async (url, options) => { calls.push({ url, body: options.body ? JSON.parse(options.body) : null }); return handler(url, options); },
    crypto: { randomUUID: () => 'stable-request-001' }, AbortSignal: { timeout: () => undefined }, structuredClone,
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {},
    confirm: () => assert.fail('ordinary Start must not ask for modal confirmation')
  });
  vm.runInContext(source + '\nthis.ui = FleetRunUI;', context);
  return { ui: context.ui, element, storage, calls, timers };
}
test('ordinary Start submits directly and suppresses rapid double clicks', async () => {
  const pending = deferred(); let current = idle;
  const f = fixture(url => url === '/api/run/start' ? pending.promise : response(current));
  await flush(); const first = f.element('runStart').click(); const second = f.element('runStart').click();
  assert.equal(f.calls.filter(call => call.url === '/api/run/start').length, 1);
  current = { ...idle, phase: 'running', running: true }; pending.resolve(response({ run: current })); await Promise.all([first, second]);
  assert.equal(f.ui.status().running, true); assert.equal(f.element('runStart').disabled, true); f.ui.dispose();
});
test('a delayed Start response cannot overwrite an acknowledged Pause', async () => {
  const start = deferred(), statusAfterPause = deferred(); let paused = false;
  const f = fixture(url => {
    if (url === '/api/run/start') return start.promise;
    if (url === '/api/master/pause') { paused = true; return response({ ok: true }); }
    return paused ? statusAfterPause.promise : response(idle);
  });
  await flush(); const starting = f.element('runStart').click(); const pausing = f.element('runPause').click(); await flush();
  start.resolve(response({ run: { ...idle, phase: 'running', running: true } })); await flush();
  assert.notEqual(f.ui.status().running, true, 'stale Start response must be ignored before the next GET completes');
  statusAfterPause.resolve(response(idle)); await Promise.all([starting, pausing]); assert.equal(f.ui.status().phase, 'paused'); f.ui.dispose();
});
test('transport retry retains the request ID and polling observes completion', async () => {
  let starts = 0, current = idle;
  const f = fixture(url => {
    if (url === '/api/run/start') {
      if (++starts === 1) throw Error('connection lost');
      current = { ...idle, phase: 'starting', active: true, requestId: 'stable-request-001' }; return response({ run: current });
    }
    return response(current);
  });
  await flush(); await f.element('runStart').click();
  assert.equal(f.element('runStart').textContent, 'Retry Start');
  await f.element('runStart').click();
  const attempts = f.calls.filter(call => call.url === '/api/run/start'); assert.equal(attempts.length, 2); assert.equal(attempts[0].body.requestId, attempts[1].body.requestId);
  current = { ...current, phase: 'running', active: false, running: true }; await f.timers[0]();
  assert.equal(f.ui.status().running, true); assert.equal(f.element('runBadge').textContent, 'RUNNING'); f.ui.dispose();
});
test('a lost POST response is reconciled by GET without another submission', async () => {
  let current = idle;
  const f = fixture(url => {
    if (url === '/api/run/start') { current = { ...idle, phase: 'running', running: true, requestId: 'stable-request-001' }; throw Error('response lost'); }
    return response(current);
  });
  await flush(); await f.element('runStart').click();
  assert.equal(f.ui.status().running, true); assert.equal(f.storage.size, 0); assert.equal(f.calls.filter(call => call.url === '/api/run/start').length, 1); f.ui.dispose();
});
