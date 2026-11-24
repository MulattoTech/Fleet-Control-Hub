'use strict';

const API_ROOT = 'https://api.github.com';
const RAW_ROOT = 'https://raw.githubusercontent.com';
const STATUSES = new Set(['done', 'in_progress', 'not_started', 'blocked']);
const MAX_GOALS = 200;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_REQUESTS = 4;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_CACHE_SIZE = 100;

function normalizeRepository(input) {
  if (typeof input !== 'string' || input.length > 500) throw new TypeError('invalid_repository');
  let candidate = input.trim();
  if (/^https?:\/\//i.test(candidate)) {
    let url;
    try { url = new URL(candidate); } catch { throw new TypeError('invalid_repository'); }
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password ||
        url.search || url.hash) throw new TypeError('invalid_repository');
    candidate = url.pathname.replace(/\/$/, '').replace(/\.git$/, '');
    candidate = candidate.startsWith('/') ? candidate.slice(1) : candidate;
  }
  const parts = candidate.split('/');
  const validPart = part => /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/.test(part) && part !== '.' && part !== '..';
  if (parts.length !== 2 || !parts.every(validPart) || parts.some(part => part.includes('..'))) throw new TypeError('invalid_repository');
  const [owner, name] = parts;
  return { owner, name, key: `${owner}/${name}` };
}

function emptyResult(repository, checkedAt, reason) {
  return {
    status: 'UNAVAILABLE', repository, branch: null, commit: null, observed_at: null,
    checked_at: checkedAt, source_path: null, source_url: null, method: null,
    total: null, done: null, in_progress: null, not_started: null, blocked: null,
    percent: null, reason
  };
}

function boundedOptions(options) {
  return { redirect: 'error', signal: options.signal, headers: {
    accept: options.accept,
    'user-agent': 'Fleet-Hub-Repository-Progress'
  } };
}

async function responseText(response, maxBytes) {
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel().catch(() => {});
          const error = new Error('response_too_large'); error.code = 'response_too_large'; throw error;
        }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock?.(); }
    return Buffer.concat(chunks, size).toString('utf8');
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    const error = new Error('response_too_large'); error.code = 'response_too_large'; throw error;
  }
  return text;
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { const error = new Error('invalid_json'); error.code = 'invalid_json'; throw error; }
}

function validateManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema_version !== 1 ||
      !Array.isArray(value.goals) || value.goals.length < 1 || value.goals.length > MAX_GOALS) return null;
  const ids = new Set();
  const counts = { total: value.goals.length, done: 0, in_progress: 0, not_started: 0, blocked: 0 };
  for (const goal of value.goals) {
    if (!goal || typeof goal !== 'object' || Array.isArray(goal) || typeof goal.id !== 'string' ||
        goal.id.length < 1 || goal.id.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(goal.id) ||
        ids.has(goal.id) || typeof goal.title !== 'string' || !goal.title.trim() || goal.title.length > 500 ||
        !STATUSES.has(goal.status)) return null;
    ids.add(goal.id); counts[goal.status]++;
  }
  return counts;
}

function checklistCounts(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length > 10000) return null;
  let total = 0; let done = 0;
  for (const line of lines) {
    const match = /^\s*(?:[-*+]\s+|\d+[.)]\s+)\[([ xX])\]\s+\S/.exec(line);
    if (match) { total++; if (match[1].toLowerCase() === 'x') done++; }
  }
  if (!total || total > MAX_GOALS) return null;
  return { total, done, in_progress: 0, not_started: total - done, blocked: 0 };
}

function withPercent(result, counts, method) {
  return { ...result, method, ...counts, percent: Math.round(counts.done * 100 / counts.total) };
}

function createRepositoryProgressReader({ fetcher = globalThis.fetch, clock = Date.now,
  timeoutMs = DEFAULT_TIMEOUT_MS, totalTimeoutMs = 10_000, maxConcurrentReads = 20,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS, maxCacheEntries = DEFAULT_CACHE_SIZE } = {}) {
  if (typeof fetcher !== 'function' || typeof clock !== 'function') throw new TypeError('invalid_reader_options');
  const timeout = Math.max(1, Math.min(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 15_000));
  const totalTimeout = Math.max(1, Math.min(Number(totalTimeoutMs) || 10_000, 12_000));
  const concurrencyLimit = Math.max(1, Math.min(Math.floor(Number(maxConcurrentReads) || 1), 50));
  const ttl = Math.max(0, Math.min(Number(cacheTtlMs) || 0, 10 * 60_000));
  const cacheLimit = Math.max(1, Math.min(Math.floor(Number(maxCacheEntries) || 1), 500));
  const cache = new Map();
  const pending = new Map();

  async function request(url, { accept, maxBytes, budget, deadlineAt }) {
    if (budget.count >= MAX_REQUESTS) throw Object.assign(new Error('request_limit'), { code: 'request_limit' });
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw Object.assign(new Error('request_timeout'), { code: 'request_timeout' });
    budget.count++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(timeout, remaining));
    try {
      const response = await Promise.race([
        fetcher(url, boundedOptions({ signal: controller.signal, accept })),
        new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(Object.assign(new Error('request_timeout'), { code: 'request_timeout' })), { once: true }))
      ]);
      if (response.status === 403 && response.headers?.get?.('x-ratelimit-remaining') === '0') throw Object.assign(new Error('rate_limited'), { code: 'rate_limited' });
      if (response.status === 429) throw Object.assign(new Error('rate_limited'), { code: 'rate_limited' });
      const body = response.status === 404 ? '' : await Promise.race([
        responseText(response, maxBytes),
        new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(Object.assign(new Error('request_timeout'), { code: 'request_timeout' })), { once: true }))
      ]);
      return { response, body };
    } catch (error) {
      if (error?.code) throw error;
      if (controller.signal.aborted || error?.name === 'AbortError') throw Object.assign(new Error('request_timeout'), { code: 'request_timeout' });
      throw Object.assign(new Error('upstream_unavailable'), { code: 'upstream_unavailable' });
    } finally { clearTimeout(timer); }
  }

  async function load(normalized, deadlineAt) {
    const checkedAt = new Date(clock()).toISOString();
    const base = emptyResult(normalized.key, checkedAt, 'upstream_unavailable');
    const budget = { count: 0 };
    try {
      const api = `${API_ROOT}/repos/${encodeURIComponent(normalized.owner)}/${encodeURIComponent(normalized.name)}`;
      const repoResponse = await request(api, { accept: 'application/vnd.github+json', maxBytes: 32 * 1024, budget, deadlineAt });
      if (!repoResponse.response.ok) throw Object.assign(new Error('upstream_unavailable'), { code: 'upstream_unavailable' });
      const repoData = parseJson(repoResponse.body);
      if (typeof repoData.default_branch !== 'string' || !repoData.default_branch || repoData.default_branch.length > 200) throw Object.assign(new Error('invalid_repository_metadata'), { code: 'invalid_repository_metadata' });
      const branch = repoData.default_branch;
      const commitResponse = await request(`${api}/commits/${encodeURIComponent(branch)}`, { accept: 'application/vnd.github+json', maxBytes: 32 * 1024, budget, deadlineAt });
      if (!commitResponse.response.ok) throw Object.assign(new Error('upstream_unavailable'), { code: 'upstream_unavailable' });
      const commitData = parseJson(commitResponse.body);
      if (typeof commitData.sha !== 'string' || !/^[a-f0-9]{40,64}$/i.test(commitData.sha)) throw Object.assign(new Error('invalid_commit'), { code: 'invalid_commit' });
      const commit = commitData.sha;
      const manifestPath = '.fleet/progress.json';
      const manifestUrl = `${RAW_ROOT}/${encodeURIComponent(normalized.owner)}/${encodeURIComponent(normalized.name)}/${commit}/${manifestPath}`;
      const manifestResponse = await request(manifestUrl, { accept: 'application/json', maxBytes: MAX_FILE_BYTES, budget, deadlineAt });
      let result = { ...base, branch, commit, source_path: manifestPath, source_url: manifestUrl };
      if (manifestResponse.response.status === 404) {
        const readmePath = 'README.md';
        const readmeUrl = `${RAW_ROOT}/${encodeURIComponent(normalized.owner)}/${encodeURIComponent(normalized.name)}/${commit}/${readmePath}`;
        const readmeResponse = await request(readmeUrl, { accept: 'text/plain', maxBytes: MAX_FILE_BYTES, budget, deadlineAt });
        if (!readmeResponse.response.ok) return { ...result, source_path: readmePath, source_url: readmeUrl, reason: 'goals_unavailable' };
        const counts = checklistCounts(readmeResponse.body);
        if (!counts) return { ...result, source_path: readmePath, source_url: readmeUrl, reason: 'goals_unavailable' };
        result = { ...result, source_path: readmePath, source_url: readmeUrl };
        return withPercent({ ...result, status: 'ESTIMATED', observed_at: checkedAt, reason: null }, counts, 'estimated_checklist_completion');
      }
      if (!manifestResponse.response.ok) throw Object.assign(new Error('upstream_unavailable'), { code: 'upstream_unavailable' });
      const counts = validateManifest(parseJson(manifestResponse.body));
      if (!counts) return { ...result, reason: 'invalid_manifest' };
      return withPercent({ ...result, status: 'ESTIMATED', observed_at: checkedAt, reason: null }, counts, 'manifest');
    } catch (error) {
      const reason = ['rate_limited', 'request_timeout', 'response_too_large', 'invalid_json', 'invalid_repository_metadata', 'invalid_commit', 'request_limit'].includes(error?.code)
        ? error.code : 'upstream_unavailable';
      return { ...base, reason };
    }
  }

  function remember(key, value, now) {
    if (cacheLimit < 1) return;
    cache.delete(key); cache.set(key, { value, expires: now + ttl });
    while (cache.size > cacheLimit) cache.delete(cache.keys().next().value);
  }

  async function read(repository, { refresh = false } = {}) {
    let normalized;
    try { normalized = normalizeRepository(repository); } catch { return emptyResult(null, new Date(clock()).toISOString(), 'invalid_repository'); }
    const now = clock();
    const cached = cache.get(normalized.key);
    if (!refresh && cached && cached.expires > now) {
      cache.delete(normalized.key); cache.set(normalized.key, cached);
      return cached.value;
    }
    if (pending.has(normalized.key)) return pending.get(normalized.key);
    if (pending.size >= concurrencyLimit) return emptyResult(normalized.key, new Date(clock()).toISOString(), 'reader_busy');
    const operation = load(normalized, Date.now() + totalTimeout).then(result => {
      const finished = clock();
      if (result.status === 'ESTIMATED') remember(normalized.key, result, finished);
      if (result.status === 'UNAVAILABLE' && cached?.value.status === 'ESTIMATED') return { ...cached.value, status: 'STALE', checked_at: new Date(finished).toISOString(), reason: result.reason };
      return result;
    }).finally(() => pending.delete(normalized.key));
    pending.set(normalized.key, operation);
    return operation;
  }

  return { read };
}

module.exports = { createRepositoryProgressReader, normalizeRepository };
