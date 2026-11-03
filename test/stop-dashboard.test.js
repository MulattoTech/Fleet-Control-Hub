'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.resolve(__dirname, '..', 'packages', 'mjobs-controller', 'Stop-Fleet-Control.ps1');
const onlyWindows = { skip: process.platform !== 'win32' };
const listening = '  TCP    127.0.0.1:8787    0.0.0.0:0    LISTENING    43210';

function runMock({ netstat = listening, tcp = '', name = 'node.exe', health = true } = {}) {
  const commands = [
    "function netstat { " + (netstat ? "'" + netstat + "'" : "return") + " }",
    'function Get-NetTCPConnection { ' + (tcp ? "[pscustomobject]@{LocalAddress='127.0.0.1';OwningProcess=" + tcp + '}' : 'return') + ' }',
    "function Get-CimInstance { [pscustomobject]@{Name='" + name + "';CommandLine='node C:\\Tools\\AO-Fleet-Control\\server.js'} }",
    "function Invoke-RestMethod { [pscustomobject]@{ok=$" + (health ? 'true' : 'false') + ";port=8787;host='127.0.0.1'} }",
    "function Stop-Process { throw 'UNEXPECTED_PROCESS_STOP' }",
    '& $env:STOP_FLEET_TEST_SCRIPT -ValidateOnly',
  ].join('; ');
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', commands], {
    encoding: 'utf8', timeout: 20000,
    env: { ...process.env, STOP_FLEET_TEST_SCRIPT: script },
  });
}

test('Windows dashboard Stop helper can verify the intended listener without stopping it', onlyWindows, () => {
  const result = runMock();
  assert.equal(result.status, 0, String(result.error || result.stderr));
  assert.match(result.stdout, /Verified dashboard server PID 43210; no stop performed/);
  assert.doesNotMatch(result.stdout + result.stderr, /UNEXPECTED_PROCESS_STOP/);
});

test('Windows dashboard Stop helper never calls a live dashboard already stopped when PID lookup fails', onlyWindows, () => {
  const result = runMock({ netstat: '' });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stdout + result.stderr, /responds on port 8787 but its owning PID cannot be verified/);
  assert.doesNotMatch(result.stdout + result.stderr, /Dashboard is already stopped|UNEXPECTED_PROCESS_STOP/);
});

test('Windows dashboard Stop helper refuses untrusted process identity', onlyWindows, () => {
  const result = runMock({ name: 'python.exe' });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stdout + result.stderr, /not the expected node.exe/);
  assert.doesNotMatch(result.stdout + result.stderr, /UNEXPECTED_PROCESS_STOP/);
});

test('Windows dashboard Stop helper fails closed when PID authorities disagree', onlyWindows, () => {
  const result = runMock({ tcp: '54321' });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stdout + result.stderr, /Conflicting dashboard listener ownership reports/);
  assert.doesNotMatch(result.stdout + result.stderr, /UNEXPECTED_PROCESS_STOP/);
});
