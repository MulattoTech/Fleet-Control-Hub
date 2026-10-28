'use strict';
const { PROJECT } = require('./config');
const SIMPLE_ID = /^[a-z0-9][a-z0-9-]{2,89}$/;
const PHASES = new Set(['requested','preflighting','draining','source_stopping','source_stopped','target_starting','activating']);
class NativeFailure extends Error {
  constructor(message, { code = '', definite = false, status = 0 } = {}) {
    super(message); this.name = 'NativeFailure'; this.code = code; this.definite = definite; this.status = status;
  }
}
class NativeModelSwitch {
  constructor(config, { fetcher = fetch } = {}) { this.config = config; this.fetcher = fetcher; }
  async api(method, route, body = undefined) {
    if (!this.config.runtimeVerified || !this.config.daemonUrl?.startsWith('http://127.0.0.1:') && !this.config.daemonUrl?.startsWith('http://localhost:')) throw Error('Verified loopback AO daemon required');
    let response;
    try {
      response = await this.fetcher(this.config.daemonUrl + '/api/v1/' + route, {
        method, headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(method === 'GET' ? 5000 : route.endsWith('/provider-switch') ? 55000 : 25000)
      });
    } catch (e) { throw new NativeFailure('AO request outcome unverified: ' + String(e.message).slice(0, 135)); }
    let value;
    try { value = await response.json(); }
    catch { throw new NativeFailure('AO returned an unreadable response; outcome unverified'); }
    if (!response.ok) {
      const error = value?.error || value;
      const code = String(error?.code || value?.code || '');
      const message = String(error?.message || value?.message || 'AO refused the operation').slice(0, 250);
      const definite = response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429;
      throw new NativeFailure(message, { code, definite, status: response.status });
    }
    return value;
  }
  route(id, suffix) { if (typeof id !== 'string' || !SIMPLE_ID.test(id)) throw Error('Invalid AO session identifier'); return 'sessions/' + id + suffix; }
  async session(id) {
    const result = await this.api('GET', this.route(id, ''));
    const s = result.session;
    if (!s || s.id !== id || s.projectId !== PROJECT || s.isTerminated) throw Error('The AO session no longer belongs to the active BabyTracker project');
    return s;
  }
  async conversation(id) { return this.api('GET', this.route(id, '/conversation')); }
  async models(id) { return this.api('GET', this.route(id, '/conversation/models')); }
  async transition(id) { return this.api('GET', this.route(id, '/interface-transition')); }

  async patchChat(id, selection, reserve) {
    const session = await this.session(id);
    if (session.mode !== 'chat' || session.harness !== selection.harness || selection.harness !== 'codex') throw Error('Native settings can change only the existing Codex Chat session');
    const [c, catalog] = await Promise.all([this.conversation(id), this.models(id)]);
    if (c.sessionId !== id || c.harness !== selection.harness) throw Error('AO conversation owner changed');
    const m = Array.isArray(catalog.models) && catalog.models.find(x => x.id === selection.model);
    if (!m) throw Error('Selected model is not offered by this live Codex Chat controller');
    if (Array.isArray(m.efforts) && m.efforts.length && !m.efforts.includes(selection.effort)) throw Error('Selected reasoning level is not supported by this model');
    const original = c.settings || {};
    const desired = { ...original, model: selection.model, reasoningEffort: selection.effort };
    // Persist the native mutation fence after all safe preflight checks.
    reserve();
    const result = await this.api('PATCH', this.route(id, '/conversation/settings'), desired);
    if (result.model !== selection.model || result.reasoningEffort !== selection.effort || result.approvalMode !== original.approvalMode) {
      throw new NativeFailure('AO settings response did not confirm the chosen model, reasoning and unchanged permissions');
    }
    const verify = await this.conversation(id);
    if (verify.settings?.model !== selection.model || verify.settings?.reasoningEffort !== selection.effort ||
        verify.settings?.approvalMode !== original.approvalMode) throw new NativeFailure('AO did not confirm the new settings on a fresh conversation read');
    return { status: 'applied_next_turn', mode: 'chat', note: 'AO saved model and reasoning for the next turn. Current in-flight work keeps its existing model; conversation and worktree are unchanged.' };
  }
  async startTransition(id, targetMode, reserve) {
    const before = await this.session(id);
    if (before.harness !== 'codex' || !['chat','tui'].includes(before.mode) || targetMode !== (before.mode === 'chat' ? 'tui' : 'chat')) throw Error('Only supported Codex interface transitions can be performed');
    const availability = await this.transition(id);
    if (availability.supported !== true || availability.targetMode !== targetMode || availability.transition && PHASES.has(availability.transition.phase)) throw Error('AO cannot safely transition this Codex session to the required interface: ' + (availability.reason || 'not available'));
    reserve();
    const result = await this.api('POST', this.route(id, '/interface-transition'), { targetMode, policy: 'drain', historyPolicy: 'strict' });
    if (!result?.transition?.id || result.transition.targetMode !== targetMode) throw new NativeFailure('AO did not confirm a durable, non-interrupting interface transition');
    return result.transition;
  }
  async switchProvider(id, selection, requestId, reserve) {
    const before = await this.session(id);
    if (before.mode !== 'tui' || before.harness === selection.harness) throw Error('AO Terminal provider switch requires two different providers');
    if (before.activity?.state !== 'idle') throw new NativeFailure('Source is not idle; current turn must finish', { code: 'PROVIDER_SWITCH_busy', definite: true, status: 409 });
    reserve();
    const result = await this.api('POST', this.route(id, '/provider-switch'), {
      targetHarness: selection.harness, model: selection.model,
      ...(selection.effortMode === 'flag' ? { effort: selection.effort } : {}),
      idempotencyKey: requestId
    });
    if (result?.status !== 'ok') throw new NativeFailure('AO did not confirm the provider switch');
    const after = await this.session(id);
    if (after.harness !== selection.harness || after.mode !== 'tui' || after.model !== selection.model ||
        after.projectId !== before.projectId || after.id !== before.id) throw new NativeFailure('Same-session provider/model switch was not verified');
    return { status: 'applied', mode: 'tui', note: 'AO verified the new provider and model in the same session, worktree and branch. No new task was sent.' };
  }
}
module.exports = { NativeModelSwitch, NativeFailure, PHASES };
