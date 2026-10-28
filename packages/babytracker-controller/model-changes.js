'use strict';
const { randomUUID } = require('node:crypto');
const { validateSelection } = require('./vendor/mjobs/provider-catalog');
const { NativeFailure, PHASES } = require('./model-switch');

const LIVE = new Set(['queued','transitioning','submitting']);
const INTERRUPTED = new Set(['unverified','reconcile_required']);
const busy = s => ['active','working','waiting_input','blocked'].includes(s?.activity?.state || s?.activity || s?.status);
const active = s => s && !s.isTerminated && !['terminated','exited','stopped'].includes(s?.activity?.state || s?.activity || s?.status);
const strip = message => String(message || '').slice(0, 240);

class ModelChanges {
  constructor(controller, native) { this.c = controller; this.native = native; }
  get(id) { return this.c.state.plans[id]; }
  save(plan, event, detail = {}) {
    plan.updatedAt = new Date(this.c.now()).toISOString();
    this.c.state.plans[plan.id] = plan; this.c.save();
    if (event) this.c.audit(event, { id: plan.id, planId: plan.planId, ...detail });
    return plan;
  }
  async request(id, input) {
    if (!this.native) throw Error('Live AO model-change adapter is not installed');
    if (this.c.state.mode === 'emergency' || this.c.state.mode === 'draining') throw Error('Cannot change agents during shutdown');
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{2,89}$/.test(id)) throw Error('Invalid agent identity');
    const original = (await this.c.sessions()).find(s => s.id === id && active(s));
    if (!original) throw Error('Live BabyTracker agent was not found');
    if (!['codex','agy'].includes(original.harness)) throw Error('Changing this provider is not supported');
    const previous = this.get(id);
    if (previous && [...LIVE,...INTERRUPTED].includes(previous.status)) throw Error('A prior model change needs completion or reconciliation; do not overwrite its checkpoint');
    const selection = validateSelection(input, await this.c.providers());
    if (!['codex','agy'].includes(selection.harness)) throw Error('Only verified Codex and AGY models are supported');
    if (original.harness === 'agy' && selection.harness === 'agy') {
      throw Error('AO cannot change models inside the same running AGY Terminal session. Use AGY /model on its terminal, or create a replacement; this dashboard will not fake an in-place switch.');
    }
    if (selection.harness === 'agy') {
      if (input.acknowledgeUnknownAgyQuota !== true) throw Error('AGY has no automatic quota cutoff; explicitly acknowledge this provider switch');
      await this.c.verifyAgyQuota();
    }
    if (original.kind === 'orchestrator' && selection.harness !== original.harness && input.acknowledgeOrchestratorHandoff !== true)
      throw Error('Orchestrator provider handoff requires an explicit primary-agent warning');
    const plan = { ...selection, id, planId: randomUUID(), sourceHarness: original.harness, sourceMode: original.mode,
      status: 'queued', at: new Date(this.c.now()).toISOString(), acknowledgedAgy: input.acknowledgeUnknownAgyQuota === true,
      originalCreatedAt: original.createdAt || null, transitionMode: null, step: null, error: null };
    this.save(plan, 'native_model_change_requested', { model: plan.model, harness: plan.harness, sourceHarness: plan.sourceHarness });
    // A Codex Chat picker is a real, next-turn settings mutation even while
    // the current turn works. Any other change waits for an idle safe boundary.
    if (original.mode === 'chat' && original.harness === 'codex' && selection.harness === 'codex') {
      await this.advance(id);
    }
    // Provider or interface handoffs are always queued to the controller tick,
    // even when idle, so the UI responds without awaiting a lengthy AO drain.
    const current = this.get(id);
    return { ok: !['blocked','unverified'].includes(current.status), status: current.status,
      note: current.note || (this.c.state.mode === 'running'
        ? 'Change queued for the next safe turn boundary; existing turn continues without interruption.'
        : 'Change queued. Controller is paused; Start Fleet to perform a deferred handoff when the agent is idle.') };
  }
  async advance(id) {
    let plan = this.get(id);
    if (!plan || !['queued','transitioning'].includes(plan.status) || !this.native) return null;
    if (this.c.state.mode === 'emergency' || this.c.state.mode === 'draining') return null;
    try {
      const s = await this.native.session(id);
      if (plan.originalCreatedAt && s.createdAt && plan.originalCreatedAt !== s.createdAt) throw Error('AO agent identity was replaced; no model change was submitted');
      if (plan.status === 'transitioning') {
        const t = await this.native.transition(id);
        const phase = t?.transition?.phase || '';
        if (PHASES.has(phase)) return { status:'transitioning' };
        if (phase !== 'completed' || s.mode !== plan.transitionMode) {
          throw Error('AO interface transition was not verified: ' + (phase || t?.reason || 'unknown'));
        }
        plan.status = 'queued'; plan.step = null;
        this.save(plan, 'model_interface_transition_verified', { mode: s.mode });
      }
      if (s.harness !== plan.sourceHarness) {
        if (s.harness === plan.harness && s.model === plan.model) {
          plan.status='applied'; plan.note='Native AO session, provider and model were verified; worktree retained.';
          return this.save(plan,'model_change_already_observed');
        }
        throw Error('Agent provider changed outside the queued model handoff. Manual reconciliation required');
      }
      if (busy(s) && !(s.mode === 'chat' && plan.harness === s.harness && s.harness === 'codex')) return { status:'queued' };
      if (plan.harness === 'agy') await this.c.verifyAgyQuota();
      if (plan.harness === 'codex' && !(s.harness==='codex' && s.mode==='chat')) {
        const gate = this.c.guard({ requireRunning: false, session: { harness: 'codex' } });
        if (gate) { plan.status='blocked'; plan.error=gate;return this.save(plan,'model_change_quota_blocked',{reason:gate}); }
      }
      const gen = this.c.state.generation;
      const reserve = step => {
        if (gen !== this.c.state.generation || ['emergency','draining'].includes(this.c.state.mode)) throw Error('Model switch superseded by fleet lifecycle change');
        if (this.get(id)?.planId !== plan.planId) throw Error('Model plan identity changed');
        plan.status='submitting'; plan.step=step; this.save(plan,'model_change_native_submitting',{step});
      };
      let result;
      if (s.mode === 'chat' && plan.harness === s.harness) {
        result = await this.native.patchChat(id,plan,()=>reserve('patch_chat'));
      } else if (s.mode === 'chat' && plan.harness === 'agy') {
        const t = await this.native.startTransition(id,'tui',()=>reserve('transition_to_tui'));
        plan.status='transitioning'; plan.transitionMode='tui'; plan.transitionId=t.id;
        plan.note='AO is draining the Codex turn before a same-session handoff to AGY. Existing code and worktree remain intact.';
        return this.save(plan,'model_change_transition_accepted',{mode:'tui'});
      } else if (s.mode === 'tui' && plan.harness === s.harness && s.harness === 'codex') {
        const t = await this.native.startTransition(id,'chat',()=>reserve('transition_to_chat'));
        plan.status='transitioning'; plan.transitionMode='chat'; plan.transitionId=t.id;
        plan.note='AO is moving Codex to Chat without interrupting the current turn; the chosen model will apply to the next Chat turn.';
        return this.save(plan,'model_change_transition_accepted',{mode:'chat'});
      } else if (s.mode === 'tui' && plan.harness !== s.harness) {
        result = await this.native.switchProvider(id,plan,plan.planId,()=>reserve('provider_switch'));
      } else throw Error('No native, non-destructive model-change route exists for this session');
      plan.status=result.status; plan.note=result.note; plan.error=null; plan.step=null;
      return this.save(plan,'native_model_change_verified',{model:plan.model,harness:plan.harness,status:plan.status});
    } catch(e) {
      // A definite busy response means AO performed no mutation; queue one
      // future attempt instead of pretending success or interrupting the turn.
      const definite = e instanceof NativeFailure && e.definite;
      if (definite && (e.code.toLowerCase().includes('busy') || e.code.toLowerCase().includes('pending_interaction'))) {
        plan.status='queued'; plan.step=null;plan.note='Waiting for the current turn or pending approval to finish; no work was interrupted.';
        return this.save(plan,'model_change_waiting_for_idle');
      }
      const submitted = plan.status === 'submitting';
      const transitioning = plan.status === 'transitioning';
      plan.status = submitted && !definite ? 'unverified' : transitioning ? 'reconcile_required' : 'blocked';
      plan.error = strip(e.message);
      plan.note = submitted ? 'AO mutation outcome requires verification. No automatic retry will be made.' :
        'AO refused the model change; original session and work remain preserved.';
      return this.save(plan,'model_change_failed',{status:plan.status,reason:plan.error});
    }
  }
  async poll() {
    for (const [id,plan] of Object.entries(this.c.state.plans)) {
      if (plan && ['queued','transitioning'].includes(plan.status)) {
        await this.advance(id); break; // one project-scoped native change per poll
      }
    }
  }
  cancel(id) {
    const plan=this.get(id);
    if(!plan || plan.status!=='queued') throw Error('Only a queued, not-yet-submitted change can be cancelled');
    plan.status='cancelled';plan.note='Queued change cancelled. The original agent and its task were never interrupted.';
    return this.save(plan,'model_change_cancelled');
  }
  async reconcile(id) {
    const p=this.get(id);
    if (!p || !['unverified','reconcile_required'].includes(p.status)) throw Error('No unverified native model operation to inspect');
    const s=await this.native.session(id);
    if (s.harness===p.harness && s.model===p.model && s.mode==='tui') {
      p.status='applied';p.note='Verified from fresh AO session: provider/model changed, session and worktree preserved.';
      return this.save(p,'model_change_reconciled');
    }
    if (s.harness==='codex' && s.mode==='chat' && p.harness==='codex') {
      const c=await this.native.conversation(id);
      if(c.settings?.model===p.model && c.settings?.reasoningEffort===p.effort) {
        p.status='applied_next_turn';p.note='Verified from AO conversation settings. Current turn remains on its prior model.';
        return this.save(p,'model_change_reconciled');
      }
    }
    if(p.transitionId) {
      const status=await this.native.transition(id);
      if(status.transition?.id===p.transitionId && PHASES.has(status.transition.phase)) {
        p.status='transitioning';p.note='Native interface transition remains in progress; no duplicate request sent.';
        return this.save(p,'model_transition_recovered');
      }
      if(status.transition?.id===p.transitionId && status.transition.phase==='completed' && s.mode===p.transitionMode) {
        p.status='queued';p.step=null;p.note='Completed native interface handoff verified. Start Fleet to complete the queued model change.';
        return this.save(p,'model_transition_recovered');
      }
    }
    throw Error('No authoritative AO evidence confirms the change; it remains unverified and no action was repeated');
  }
  afterRestart() {
    for(const p of Object.values(this.c.state.plans)) {
      if(p && ['queued','submitting','transitioning'].includes(p.status)) {
        p.status=p.status==='queued'?'resume_required':'reconcile_required';
        p.note='Controller restarted: native model operation paused for manual verification/resume. No new agent work started.';
      }
    }
  }
  resume(id) {
    const p=this.get(id);
    if(!p || p.status!=='resume_required') throw Error('No restart-paused model change to resume');
    p.status='queued';p.note='Resumed the previously requested change; waiting for an idle safe boundary.';
    return this.save(p,'model_change_resumed');
  }
}
module.exports={ModelChanges};
