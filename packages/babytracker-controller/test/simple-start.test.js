'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Readable } = require('node:stream');
const { createServer } = require('../server');

// Exercise the actual request handler without opening a native runtime or socket.
function request(server, { method = 'GET', url = '/api/session', headers = {}, body } = {}) {
  return new Promise(resolve => {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    Object.assign(req, { method, url, socket: { localPort: 9097 }, headers: { host: '127.0.0.1:9097', ...headers } });
    const res = { setHeader() {}, writeHead(status) { this.status = status; }, end(text) { resolve({ status: this.status, value: JSON.parse(text) }); } };
    server.emit('request', req, res);
  });
}

test('simpleStart and legacy Start use the same protected local action path', async () => {
  let starts = 0;
  const server = createServer({ config: { projectId: 'babytracker' }, controller: { simpleStart: async () => { starts++; return { ok: true }; } } });
  const token = (await request(server)).value.token;
  const headers = { origin: 'http://127.0.0.1:9097', 'content-type': 'application/json', 'x-babytracker-fleet': token };
  assert.equal((await request(server, { method: 'POST', url: '/api/action', body: { action: 'simpleStart' } })).status, 403);
  assert.equal(starts, 0);
  for (const action of ['simpleStart', 'start']) {
    assert.equal((await request(server, { method: 'POST', url: '/api/action', headers, body: { action } })).status, 200);
  }
  assert.equal(starts, 2);
});

test('the dashboard Start click submits once without confirmation and polls actual state', async () => {
  const nodes = new Map(), calls = [], observed = [], timers = [];
  const start = { dataset: { action: 'start' }, addEventListener(name, callback) { this[name] = callback; } };
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { addEventListener() {}, classList: { add() {} } });
    return nodes.get(id);
  };
  let release, mode = 'paused';
  const submitted = new Promise(resolve => { release = resolve; });
  const context = vm.createContext({
    document: { getElementById: node, querySelectorAll: () => [start] },
    AbortSignal, setTimeout, clearTimeout,
    setInterval(callback) { timers.push(callback); },
    confirm() { throw Error('Start must not require confirmation'); },
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      if (url === '/api/session') return { ok: true, json: async () => ({ token: 'local-token' }) };
      if (url === '/api/action') { await submitted; mode = 'running'; return { ok: true, json: async () => ({ ok: true }) }; }
      return { ok: true, json: async () => ({ mode, sessions: [], quotaPolicy: { blocked: false } }) };
    }, observed
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8'), context);
  vm.runInContext('render = s => { snapshot = s; observed.push(s.mode); }; toast = () => {};', context);
  await new Promise(resolve => setImmediate(resolve));
  const first = start.click();
  await start.click();
  assert.equal(start.disabled, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(c => c.url === '/api/action').length, 1);
  assert.equal(JSON.parse(calls.find(c => c.url === '/api/action').options.body).action, 'simpleStart');
  release(); await first;
  assert.equal(observed.at(-1), 'running');
  mode = 'paused'; await timers[0]();
  assert.equal(observed.at(-1), 'paused');
});
