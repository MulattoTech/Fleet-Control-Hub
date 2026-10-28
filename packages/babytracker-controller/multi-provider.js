'use strict';
const fs = require('node:fs');
const { createProviderRuntime } = require('./vendor/mjobs/provider-catalog');

const MJOBS_ORIGIN = 'http://127.0.0.1:8787'; // Read-only shared catalog; no MJobs action API calls.
const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const EFFORTS = new Set(['low','medium','high','xhigh']);
const unknownAgy = reason => ({ provider: 'agy', fresh: false, remainingPercent: null, windows: [], observedAt: null,
  autoCutoffVerified: false, reason, source: 'Native AGY usage observation (read-only MJobs feed)' });

function validCodexModels(value) {
  if (!value || !Array.isArray(value.providers)) return [];
  const provider = value.providers.find(p => p.id === 'codex' && p.available === true);
  if (!provider || !Array.isArray(provider.models)) return [];
  return provider.models.filter(m => m && typeof m.id === 'string' && ID.test(m.id) &&
    typeof m.name === 'string' && m.name.length <= 100 &&
    Array.isArray(m.efforts) && m.efforts.length > 0 &&
    m.efforts.every(e => EFFORTS.has(e))).slice(0, 20).map(m => ({
      id: m.id, name: m.name, efforts: [...new Set(m.efforts)], defaultEffort: EFFORTS.has(m.defaultEffort) ? m.defaultEffort : 'medium', effortMode: 'flag'
    }));
}
function sanitizeUsage(raw, now = Date.now()) {
  const p = raw?.providers?.find(p => p.id === 'agy');
  if (!p) return unknownAgy('No AGY usage observation is available. AGY has no verified automatic quota cutoff.');
  const observed = Date.parse(p.observedAt || '');
  const fresh = p.fresh === true && Number.isFinite(observed) && observed <= now &&
    now - observed <= 90000 && Number.isFinite(p.remainingPercent) &&
    p.remainingPercent >= 0 && p.remainingPercent <= 100;
  const windows = Array.isArray(p.windows) ? p.windows.slice(0, 20).filter(w => w &&
    typeof w.bucket === 'string' && ID.test(w.bucket)).map(w => ({
    bucket: w.bucket, remainingPercent: Number.isFinite(w.remainingPercent) &&
      w.remainingPercent >= 0 && w.remainingPercent <= 100 ? w.remainingPercent : null,
    disabled: w.disabled === true
  })) : [];
  return { provider: 'agy', fresh, remainingPercent: fresh ? p.remainingPercent : null,
    windows, observedAt: Number.isFinite(observed) ? new Date(observed).toISOString() : null,
    autoCutoffVerified: false, source: 'Native AGY statusline; client-observed, not provider-polling',
    reason: fresh ? 'Observed native AGY quota; provider sampling time and automatic cutoff are unverified.' :
      'AGY quota is missing or stale. Only explicit manual one-turn dispatch is allowed.' };
}

function createSharedProviders(config, { fetcher = fetch, local = null, now = Date.now } = {}) {
  const own = local || createProviderRuntime({ codexModels: config.codexModels, codexEfforts: ['low','medium','high','xhigh'], codexExe: config.codexExe });
  let shared = null, sharedAt = 0;
  async function remote(path) {
    const response = await fetcher(MJOBS_ORIGIN + path, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) throw Error('Read-only MJobs provider response unavailable');
    return response.json();
  }
  async function get() {
    const base = await own.get(), providers = base.providers.map(p => ({ ...p }));
    const codex = providers.find(p => p.id === 'codex');
    if (codex && !config.codexModels?.length) {
      if (now() - sharedAt > 15000 || !shared) {
        try { shared = validCodexModels(await remote('/api/providers')); }
        catch { shared = []; }
        sharedAt = now();
      }
      if (fs.existsSync(config.codexExe || '') && shared.length) {
        codex.available = true; codex.error = null; codex.models = shared;
      } else {
        codex.available = false; codex.error = 'No live verified Codex model catalog from MJobs; do not guess available model IDs';
      }
    }
    // Google AI Plus request: expose only Gemini models, not AGY's third-party
    // models whose entitlement may differ by subscription tier.
    const agy = providers.find(p => p.id === 'agy');
    if (agy) { agy.models = (agy.models || []).filter(m => /^gemini-[a-z0-9][a-z0-9.-]+$/.test(m.id)); agy.available = agy.available && agy.models.length > 0; }
    const gemini = providers.find(p => p.id === 'gemini');
    if (gemini) gemini.error = 'Standalone Gemini CLI not configured; Gemini models are available through AGY instead';
    return { at: new Date(now()).toISOString(), source: 'Live AGY models + verified shared Codex catalog (read-only)',
      providers, note: 'AGY Google Gemini models use an independent allowance; no automatic percentage cutoff is verified.' };
  }
  async function usage() {
    try { return sanitizeUsage(await remote('/api/gemini-usage'), now()); }
    catch { return unknownAgy('AGY quota feed unavailable. Only explicitly confirmed manual one-turn work is permitted.'); }
  }
  return { get, usage };
}
module.exports = { createSharedProviders, sanitizeUsage, validCodexModels, unknownAgy, MJOBS_ORIGIN };
