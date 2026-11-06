'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  AO_URL, ATTEMPTS_FILE, STATUS_FILE, latchEnabled, normalizedTrigger, readCampaign,
  readAttempts, saveAttempts, validateAttempts, projectSession, parseTop,
  createRuntimeAdapters, runOnce, parseArguments
} = require('./fleet-codex-watchdog');
const NOW = Date.parse('2026-10-31T22:00:00Z');
const TRIGGER = '2026-10-30T13:50:29.580Z';
const scope = { version: 1, projectIds: ['mjobs-luna'] };
const identityKeys = ['id', 'projectId', 'createdAt', 'harness', 'mode', 'terminalGeneration'];
const identityCore = {
  sessionIdentity: value => value && identityKeys.every(key => typeof value[key] === 'string') ?
    Object.fromEntries(identityKeys.map(key => [key, value[key]])) : null,
  sameIdentity: (a, b) => !!a && !!b && JSON.stringify(a) === JSON.stringify(b)
};
const session = (changes = {}) => ({
  id: 'mjobs-luna-1', projectId: 'mjobs-luna', harness: 'codex', mode: 'tui', kind: 'worker',
  createdAt: '2026-10-30T10:00:00Z', updatedAt: '2026-10-31T21:00:00Z',
  terminalGeneration: '11111111-2222-3333-4444-555555555555', isTerminated: false,
  activity: { state: 'exited' }, statusReadiness: 'ready', provisionState: 'ready',
  model: 'test-model', branch: 'fixture', ...changes
});
function runtimeFixture(changes = {}) {
  const state = { sessions: [session()], count: 0, controller: 'stopped', fetches: [], commands: [], ...changes };
  const adapters = createRuntimeAdapters({ root: __dirname, scope, core: identityCore,
    now: () => NOW, aoExecutable: 'installed-ao.exe', io: { existsSync: () => true },
    isLatched: () => !state.disarmed,
    fetchImpl: async (url, options) => {
      state.fetches.push({ url, options });
      if (state.offline) throw Error('private connection detail');
      if (url === AO_URL + '/api/v1/sessions') return { ok: true, json: async () => ({ sessions: state.sessions }) };
      if (url.includes('/conversation?limit=1')) {
        if (state.controllerError) throw Error('private conversation detail');
        return { ok: true, json: async () => ({ controller: state.controller, messages: ['DO_NOT_RETAIN'] }) };
      }
      throw Error('Unexpected URL');
    },
    exec: async (file, args, options) => {
      state.commands.push({ file, args, options });
      if (state.afterCommand) state.afterCommand(state);
      return { stdout: JSON.stringify({ data: state.rows || [{ id: 'mjobs-luna-1', processCount: state.count }] }) };
    }, evidenceOptions: { platform: 'linux', ...(changes.evidenceOptions || {}) }
  });
  return { state, adapters };
}
function diskFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-watchdog-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'emergency-latch.json'), JSON.stringify({ enabled: true, triggeredAt: TRIGGER }));
  return root;
}

test('latch missing is disarmed; malformed or nonboolean state stays latched', t => {
  const root = diskFixture(t), file = path.join(root, 'emergency-latch.json');
  assert.equal(latchEnabled(root), true);
  fs.writeFileSync(file, '{"enabled":false}'); assert.equal(latchEnabled(root), false);
  fs.writeFileSync(file, '{"enabled":"false"}'); assert.equal(latchEnabled(root), true);
  fs.writeFileSync(file, 'broken'); assert.equal(latchEnabled(root), true);
  fs.unlinkSync(file); assert.equal(latchEnabled(root), false);
});

test('session projection and failed-runtime status contain no conversations', async () => {
  const current = session({ messages: ['secret'], prompt: 'secret', output: 'secret', credentials: 'secret' });
  assert(!JSON.stringify(projectSession(current)).includes('secret'));
  const { adapters, state } = runtimeFixture({ sessions: [current] });
  const rows = await adapters.readSessions();
  assert(!JSON.stringify(rows).includes('secret'));
  assert.equal(state.fetches.length, 1, 'Inventory reads never inspect unrelated conversations');
  assert.equal(state.fetches[0].options.redirect, 'error');
});

test('known-offline AO never invokes a command that could auto-start it', async () => {
  const { adapters, state } = runtimeFixture({ offline: true });
  await assert.rejects(adapters.stopSession(session()));
  await assert.rejects(adapters.verifyStopped(session()));
  assert.equal(state.commands.length, 0);
});

test('stop uses exact native session and project, with no shell or global stop', async () => {
  const { adapters, state } = runtimeFixture();
  await adapters.stopSession(session());
  assert.equal(state.fetches[0].url, AO_URL + '/api/v1/sessions');
  assert.deepEqual(state.commands[0].args, ['session', 'exit-agent', 'mjobs-luna-1', '--project', 'mjobs-luna', '--json']);
  assert.equal(state.commands[0].options.shell, false);
  assert.equal(state.commands[0].options.timeout, 12000);
  assert.equal(state.commands[0].file, 'installed-ao.exe');
  await assert.rejects(adapters.stopSession(session({ projectId: 'manual-project' })), /not an explicit fleet/);
  await assert.rejects(adapters.stopSession(session({ harness: 'agy' })), /not an explicit fleet/);
  assert.equal(state.commands.length, 1);
});

test('a recreated or generation-changed stop target cannot reuse an old identity', async () => {
  const { adapters, state } = runtimeFixture({ sessions: [session({ terminalGeneration: 'changed-generation' })] });
  await assert.rejects(adapters.stopSession(session()), /changed/);
  assert.equal(state.commands.length, 0);
});

test('a released latch blocks native submission after membership recheck', async () => {
  const { adapters, state } = runtimeFixture({ disarmed: true });
  await assert.rejects(adapters.stopSession(session()), /released before/);
  assert.equal(state.commands.length, 0);
});

test('only a numeric zero plus stopped native state proves the direct stop', async t => {
  for (const [label, count, activity, expected] of [
    ['zero exited', 0, 'exited', true], ['zero active', 0, 'active', false],
    ['unknown exited', null, 'exited', false], ['missing exited', undefined, 'exited', false],
    ['string zero', '0', 'exited', false], ['positive exited', 2, 'exited', false]
  ]) await t.test(label, async () => {
    const current = session({ activity: { state: activity } });
    const { adapters, state } = runtimeFixture({ sessions: [current], count });
    assert.equal(await adapters.verifyStopped(current), expected);
    if (activity === 'active') assert.equal(state.commands.length, 0, 'Clearly live workers do not delay bounded stop submission with top/probe');
    else {
      assert.deepEqual(state.commands[0].args, ['session', 'top', '--all', '--project', 'mjobs-luna', '--json']);
      assert(state.fetches.length >= 2, 'Runtime inventory is bounded by native session rechecks');
    }
  });
});

test('chat verification reads only its controller string and respects unknown state', async () => {
  const current = session({ mode: 'chat', activity: { state: 'idle' } });
  const { adapters, state } = runtimeFixture({ sessions: [current], count: 0 });
  assert.equal(await adapters.verifyStopped(current), true);
  assert.equal(state.fetches.filter(row => row.url.includes('/conversation?limit=1')).length, 2);
  state.controllerError = true;
  assert.equal(await adapters.verifyStopped(current), false);
});

test('Chat exited metadata and numeric zero cannot override an unverified or live controller', async t => {
  for (const controller of ['ready', 'busy', 'unknown', undefined]) await t.test(String(controller), async () => {
    const current = session({ mode: 'chat', activity: { state: 'exited' } });
    const { adapters, state } = runtimeFixture({ sessions: [current], count: 0, controller });
    assert.equal(await adapters.verifyStopped(current), false);
    assert.equal(state.commands.length, 0, 'Unstopped Chat never needs a top/probe');
  });
});

test('native timeouts are capped by the sweep budget and cancellation prevents new submissions', async () => {
  const { adapters, state } = runtimeFixture();
  const abort = new AbortController();
  await adapters.stopSession(session(), { signal: abort.signal, remainingMs: () => 750 });
  assert.equal(state.commands[0].options.timeout, 750);
  assert.equal(state.commands[0].options.signal, abort.signal);
  abort.abort();
  const fetches = state.fetches.length;
  await assert.rejects(adapters.stopSession(session(), { signal: abort.signal, remainingMs: () => 0 }));
  assert.equal(state.commands.length, 1); assert.equal(state.fetches.length, fetches);
});

test('a changed target during top invalidates apparent zero', async () => {
  const { adapters } = runtimeFixture({ afterCommand: state => {
    state.sessions = [session({ createdAt: '2026-10-31T21:55:00Z' })];
  } });
  assert.equal(await adapters.verifyStopped(session()), false);
});

test('malformed or duplicate top identities never produce a fabricated zero', () => {
  assert.throws(() => parseTop('broken'), /malformed/);
  assert.throws(() => parseTop('{"sessions":[]}'), /unavailable/);
  assert.throws(() => parseTop(JSON.stringify({ data: [{ id: 'a', processCount: 0 }, { id: 'a', processCount: 0 }] })), /ambiguous/);
  assert.equal(parseTop(JSON.stringify({ data: [{ id: 'a' }] })).get('a'), null);
});

test('native absence proof can verify unknown counts without coercing the count', async () => {
  let probes = 0;
  const { adapters } = runtimeFixture({ count: null, evidenceOptions: { platform: 'win32', runProbe: async request => {
    probes++;
    return { version: 1, probeId: request.probeId, complete: true, observedAt: new Date(NOW).toISOString(),
      results: request.targets.map(target => ({ id: target.id, absent: true, proof: {
        completeInventory: true, stableInventory: true, stableRegistry: true, noMatchingHost: true,
        ownershipClear: true, noSessionOwnedProvider: true, registryAbsent: true,
        chatOwnershipClear: true, instanceVerified: true, stableInstance: true
      } })) };
  } } });
  assert.equal(await adapters.verifyStopped(session()), true);
  assert.equal(probes, 1);
});

test('exited terminal-host proof verifies only absent provider children, not zero OS processes', async () => {
  let probes = 0;
  const { adapters } = runtimeFixture({ count: 1, evidenceOptions: { platform: 'win32', runProbe: async request => {
    probes++;
    return { version: 1, probeId: request.probeId, complete: true, observedAt: new Date(NOW).toISOString(),
      results: request.targets.map(target => ({ id: target.id, exited: true, hostPid: 123,
        hostCreatedAt: '2026-10-31T20:00:00Z', launchId: target.terminalGeneration, exitCode: 0,
        proof: { stableInventory: true, stableRegistry: true, stableInstance: true, listenerOwned: true,
          exactGeneration: true, noProviderChildren: true, nativeExitConfirmed: true } })) };
  } } });
  assert.equal(await adapters.verifyStopped(session()), true);
  assert.equal(probes, 1);
});

test('corrupt retry ledger blocks mutation and stays intact', async t => {
  const root = diskFixture(t), ledger = path.join(root, ATTEMPTS_FILE);
  fs.writeFileSync(ledger, '{bad');
  let sweeps = 0;
  const core = { readScope: () => scope, sweepFleetCodex: async () => { sweeps++; } };
  const status = await runOnce({ root, watchdogPid: 123, now: () => NOW, core });
  assert.equal(sweeps, 0); assert.equal(status.phase, 'partial_stop');
  assert.equal(status.remainingTotal, null); assert.equal(status.manualSessionsPreserved, true);
  assert.equal(fs.readFileSync(ledger, 'utf8'), '{bad');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, STATUS_FILE))).scope, 'fleet-owned');
});

test('campaign timestamps normalize precision but reject missing, malformed, or impossible dates', async t => {
  assert.equal(normalizedTrigger('2026-10-30T13:50:29.58Z'), TRIGGER);
  assert.equal(normalizedTrigger('2026-10-30T13:50:29.5801234Z'), TRIGGER, 'PowerShell round-trip timestamp is a supported campaign');
  assert.equal(normalizedTrigger('2026-10-30T13:50:29.580123456Z'), TRIGGER);
  assert.equal(normalizedTrigger('2026-02-30T13:50:29.58Z'), null);
  for (const triggeredAt of [undefined, 'yesterday', '2026-10-30T25:50:29Z']) await t.test(String(triggeredAt), async () => {
    const root = diskFixture(t); let calls = 0;
    fs.writeFileSync(path.join(root, 'emergency-latch.json'), JSON.stringify({ enabled: true, triggeredAt }));
    const status = await runOnce({ root, watchdogPid: 123, now: () => NOW,
      core: { readScope: () => scope, sweepFleetCodex: async () => { calls++; } } });
    assert.equal(calls, 0); assert.equal(status.phase, 'partial_stop');
    assert.equal(status.remainingTotal, null); assert(!fs.existsSync(path.join(root, ATTEMPTS_FILE)));
  });
});

test('only a new later campaign resets a valid budget; same epoch, scope edits, and rollback do not', t => {
  const root = diskFixture(t), campaign = readCampaign(root, scope);
  const attempts = { 'mjobs-luna-1': { fingerprint: 'a'.repeat(64), count: 3, lastAttempt: NOW - 60000 } };
  saveAttempts(root, attempts, campaign);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, ATTEMPTS_FILE))).version, 2);
  fs.writeFileSync(path.join(root, 'emergency-latch.json'), JSON.stringify({ enabled: true, triggeredAt: '2026-10-30T13:50:29.58Z' }));
  assert.equal(readAttempts(root, readCampaign(root, scope))['mjobs-luna-1'].count, 3);
  assert.throws(() => readAttempts(root, readCampaign(root, { version: 1, projectIds: ['mjobs-luna', 'another-project'] })), /invalid/);
  fs.writeFileSync(path.join(root, 'emergency-latch.json'), JSON.stringify({ enabled: true, triggeredAt: '2026-10-29T13:50:29.580Z' }));
  assert.throws(() => readAttempts(root, readCampaign(root, scope)), /invalid/);
  fs.writeFileSync(path.join(root, 'emergency-latch.json'), JSON.stringify({ enabled: true, triggeredAt: '2026-10-31T13:50:29.580Z' }));
  assert.deepEqual(Object.keys(readAttempts(root, readCampaign(root, scope))), []);
});

test('unsupported or corrupt old ledger cannot be laundered by a fresh campaign', async t => {
  const root = diskFixture(t), file = path.join(root, ATTEMPTS_FILE);
  fs.writeFileSync(file, JSON.stringify({ version: 1, attempts: {} }));
  const before = fs.readFileSync(file, 'utf8'); let calls = 0;
  const status = await runOnce({ root, watchdogPid: 123, now: () => NOW,
    core: { readScope: () => scope, sweepFleetCodex: async () => { calls++; } } });
  assert.equal(calls, 0); assert.equal(status.phase, 'partial_stop');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('campaign change between reservation and submission blocks the stale sweep', async t => {
  const root = diskFixture(t); let calls = 0;
  const core = { readScope: () => scope, sweepFleetCodex: async options => {
    options.attempts['mjobs-luna-1'] = { fingerprint: 'a'.repeat(64), count: 1, lastAttempt: NOW };
    fs.writeFileSync(path.join(root, 'emergency-latch.json'), JSON.stringify({ enabled: true, triggeredAt: '2026-10-31T13:50:29.580Z' }));
    await options.stopSession(session());
  } };
  const status = await runOnce({ root, watchdogPid: 123, now: () => NOW, core,
    adapters: { stopSession: async () => { calls++; } } });
  assert.equal(calls, 0); assert.equal(status.phase, 'partial_stop');
  assert.equal(status.remainingTotal, null); assert(!fs.existsSync(path.join(root, ATTEMPTS_FILE)));
});

test('stop intent is durably recorded before the native adapter is called', async t => {
  const root = diskFixture(t), record = { fingerprint: 'a'.repeat(64), count: 1, lastAttempt: NOW, inspectedAt: NOW - 1 };
  let nativeCalls = 0;
  const core = { readScope: () => scope, sweepFleetCodex: async options => {
    options.attempts['mjobs-luna-1'] = record;
    await options.stopSession(session());
    return { phase: 'holding_zero', remainingTotal: 0, remaining: { codex: 0 } };
  } };
  const adapters = { stopSession: async () => {
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, ATTEMPTS_FILE))).attempts['mjobs-luna-1'], record);
    nativeCalls++;
  } };
  const status = await runOnce({ root, watchdogPid: 123, now: () => NOW, core, adapters });
  assert.equal(nativeCalls, 1); assert.equal(status.phase, 'holding_zero');
  assert.equal(status.orphanProcessesInspected, false); assert.equal(status.remainingUnit, 'AO Codex sessions');
});

test('failed ledger persistence never reaches native mutation', async t => {
  const root = diskFixture(t); let calls = 0;
  const core = { readScope: () => scope, sweepFleetCodex: async options => {
    options.attempts['mjobs-luna-1'] = { fingerprint: 'b'.repeat(64), count: 1, lastAttempt: NOW };
    await options.stopSession(session());
  } };
  const io = { ...fs, writeFileSync: (file, ...args) => {
    if (file.includes(ATTEMPTS_FILE)) throw Error('disk failure');
    return fs.writeFileSync(file, ...args);
  } };
  const status = await runOnce({ root, watchdogPid: 123, now: () => NOW, core, io,
    adapters: { stopSession: async () => { calls++; } } });
  assert.equal(calls, 0); assert.equal(status.phase, 'partial_stop'); assert.equal(status.remainingTotal, null);
  assert.equal(status.remaining.codex, null);
});

test('dry-run has an independent no-mutation boundary and writes no state', async t => {
  const root = diskFixture(t); let calls = 0;
  const core = { readScope: () => scope, sweepFleetCodex: async options => { await options.stopSession(session()); } };
  await runOnce({ root, watchdogPid: 123, now: () => NOW, core, dryRun: true,
    adapters: { stopSession: async () => { calls++; } } });
  assert.equal(calls, 0);
  assert.deepEqual(fs.readdirSync(root), ['emergency-latch.json']);
});

test('disarmed sweeps do not inspect native runtime or mutate retry history', async t => {
  const root = diskFixture(t); fs.writeFileSync(path.join(root, 'emergency-latch.json'), '{"enabled":false}');
  const status = await runOnce({ root, watchdogPid: 123, now: () => NOW,
    core: { readScope: () => { throw Error('Must not inspect'); } } });
  assert.equal(status.active, false); assert.equal(status.phase, 'disarmed');
  assert(!fs.existsSync(path.join(root, ATTEMPTS_FILE)));
});

test('a persistence error after explicit disarm cannot advertise an active stop', async t => {
  const root = diskFixture(t);
  const core = { readScope: () => scope, sweepFleetCodex: async () => {
    fs.writeFileSync(path.join(root, 'emergency-latch.json'), '{"enabled":false}');
    return { phase: 'partial_stop', remainingTotal: null };
  } };
  const io = { ...fs, writeFileSync: (file, ...args) => {
    if (file.includes(ATTEMPTS_FILE)) throw Error('disk failure');
    return fs.writeFileSync(file, ...args);
  } };
  const status = await runOnce({ root, watchdogPid: 123, now: () => NOW, core, io, adapters: {} });
  assert.equal(status.active, false); assert.equal(status.phase, 'disarmed');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, STATUS_FILE))).phase, 'disarmed');
});

test('real scope engine and runtime adapters stop only registered Codex sessions', async t => {
  const root = diskFixture(t), core = require('./fleet-codex-scope');
  core.ensureScope(root, 'mjobs-luna');
  const rows = [session({ activity: { state: 'active' } }),
    session({ id: 'manual-1', projectId: 'manual-project', activity: { state: 'active' } }),
    session({ id: 'mjobs-agy-1', harness: 'agy', activity: { state: 'active' } })];
  const commands = [];
  const status = await runOnce({ root, watchdogPid: 123, now: () => NOW, core,
    adapterOptions: { aoExecutable: __filename,
      fetchImpl: async url => {
        assert.equal(url, AO_URL + '/api/v1/sessions');
        return { ok: true, json: async () => ({ sessions: rows }) };
      }, exec: async (file, args) => {
        commands.push(args);
        if (args[1] === 'exit-agent') rows[0].activity.state = 'exited';
        return { stdout: JSON.stringify({ data: [{ id: rows[0].id, processCount: rows[0].activity.state === 'exited' ? 0 : 1 }] }) };
      }, evidenceOptions: { platform: 'linux' }
    }
  });
  assert.equal(status.phase, 'holding_zero'); assert.equal(status.remainingTotal, 0);
  assert.deepEqual(commands.filter(args => args[1] === 'exit-agent'),
    [['session', 'exit-agent', 'mjobs-luna-1', '--project', 'mjobs-luna', '--json']]);
  assert.equal(rows[1].activity.state, 'active'); assert.equal(rows[2].activity.state, 'active');
  assert.equal(status.orphanProcessesInspected, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, ATTEMPTS_FILE))).attempts['mjobs-luna-1'].count, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, ATTEMPTS_FILE))).attempts['mjobs-luna-1'].inspectedAt, NOW);
});

test('proof-inspection fairness survives ledger persistence independently of stop attempts', t => {
  const root = diskFixture(t), campaign = readCampaign(root, scope);
  const record = { fingerprint: 'a'.repeat(64), count: 0, lastAttempt: 0, inspectedAt: NOW };
  saveAttempts(root, { 'mjobs-luna-1': record }, campaign);
  assert.deepEqual(readAttempts(root, campaign)['mjobs-luna-1'], record);
  const oldRecord = { fingerprint: 'b'.repeat(64), count: 2, lastAttempt: NOW - 60000 };
  saveAttempts(root, { 'mjobs-luna-2': oldRecord }, campaign);
  assert.deepEqual(readAttempts(root, campaign)['mjobs-luna-2'], { ...oldRecord, inspectedAt: 0 });
  for (const invalid of [-1, '100', Infinity]) {
    assert.throws(() => validateAttempts({ version: 2, campaign, attempts: { a: { ...record, inspectedAt: invalid } } }));
  }
});

test('real scope engine reports AO offline with unknown remaining and no command', async t => {
  const root = diskFixture(t), core = require('./fleet-codex-scope');
  core.ensureScope(root, 'mjobs-luna'); let calls = 0;
  const status = await runOnce({ root, watchdogPid: 123, now: () => NOW, core,
    adapterOptions: { fetchImpl: async () => { throw Error('secret network trace'); }, exec: async () => { calls++; } }
  });
  assert.equal(status.phase, 'partial_stop'); assert.equal(status.remainingTotal, null); assert.equal(calls, 0);
  assert(status.recentErrors.some(message => message.includes('Orchestrator session feed is unavailable')));
  assert(!JSON.stringify(status).includes('secret network trace'));
});

test('attempt and CLI validation reject unbounded or ambiguous inputs', () => {
  const campaign = { triggeredAt: TRIGGER, scopeFingerprint: 'c'.repeat(64) };
  assert.throws(() => validateAttempts({ version: 2, campaign, attempts: { a: { fingerprint: 'x', count: 1, lastAttempt: NOW } } }));
  assert.throws(() => validateAttempts({ version: 2, campaign, attempts: { a: { fingerprint: 'a'.repeat(64), count: 4, lastAttempt: NOW } } }));
  assert.throws(() => validateAttempts({ version: 2, campaign,
    attempts: JSON.parse('{"__proto__":{"fingerprint":"' + 'a'.repeat(64) + '","count":1,"lastAttempt":1}}') }));
  assert.deepEqual(parseArguments(['--root', path.resolve('/tmp/fixture'), '--watchdog-pid', '123', '--dry-run']),
    { root: path.resolve('/tmp/fixture'), watchdogPid: 123, dryRun: true });
  for (const args of [[], ['--root', 'relative', '--watchdog-pid', '123'], ['--root', '/tmp', '--watchdog-pid', '0'],
    ['--root', '/tmp', '--watchdog-pid', '123', '--all']]) assert.throws(() => parseArguments(args));
});
