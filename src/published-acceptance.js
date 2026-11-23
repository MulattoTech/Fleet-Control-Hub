'use strict';

const SHA_RE = /^[0-9a-f]{40}$/i;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ALLOWED_RESULTS = new Set(['PASS', 'PARTIAL', 'NOT_RUN']);
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;

function timestamp(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('Clock returned an invalid time');
  return date.toISOString();
}

function safeProject(projectId, projects) {
  const configured = projects instanceof Map ? projects.get(projectId) : projects?.[projectId];
  if (!configured || typeof configured !== 'object') throw new RangeError('Project is not configured');
  const project = {
    project_id: projectId,
    repository: configured.repository,
    branch: configured.branch,
    originalPath: configured.originalPath,
    referencePath: configured.referencePath,
    originalSchema: configured.originalSchema,
    referenceSchema: configured.referenceSchema,
    originalIdField: configured.originalIdField || 'requirement_id',
    originalResultField: configured.originalResultField || 'result',
  };
  if (typeof projectId !== 'string' || !projectId.trim() || projectId.length > 100 ||
      typeof project.repository !== 'string' || !REPO_RE.test(project.repository) ||
      typeof project.branch !== 'string' || !project.branch.trim() || project.branch.length > 200 ||
      !safePath(project.originalPath) || !safePath(project.referencePath) ||
      project.originalPath === project.referencePath) {
    throw new TypeError('Project configuration is invalid');
  }
  return project;
}

function safePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 300 &&
    !value.startsWith('/') && !value.includes('\\') &&
    value.split('/').every((part) => part && part !== '.' && part !== '..');
}

function matrixCounts(rows, idField, resultField) {
  if (!Array.isArray(rows) || rows.length > 10000) throw new Error('remote_malformed');
  const seen = new Set();
  const counts = { pass: 0, partial: 0, not_run: 0, total: rows.length };
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row) ||
        typeof row[idField] !== 'string' || !/^[a-z0-9][a-z0-9_.:-]{0,127}$/i.test(row[idField]) || seen.has(row[idField]) ||
        !ALLOWED_RESULTS.has(row[resultField])) {
      throw new Error('remote_malformed');
    }
    seen.add(row[idField]);
    if (row[resultField] === 'PASS') counts.pass += 1;
    else if (row[resultField] === 'PARTIAL') counts.partial += 1;
    else counts.not_run += 1;
  }
  return counts;
}

function referenceCounts(matrix) {
  if (!matrix || typeof matrix !== 'object' || Array.isArray(matrix) ||
      !Array.isArray(matrix.canonical_ids) || !matrix.result_by_id ||
      typeof matrix.result_by_id !== 'object' || Array.isArray(matrix.result_by_id)) {
    throw new Error('remote_malformed');
  }
  const keys = Object.keys(matrix.result_by_id);
  const ids = matrix.canonical_ids;
  if (keys.length !== ids.length || new Set(ids).size !== ids.length ||
      ids.some((id) => typeof id !== 'string' || !id.trim() || !Object.hasOwn(matrix.result_by_id, id))) {
    throw new Error('remote_malformed');
  }
  return matrixCounts(ids.map((id) => {
    const value = matrix.result_by_id[id];
    return { id, result: value && typeof value === 'object' ? value.result : value };
  }), 'id', 'result');
}

async function readJson(response) {
  if (!response || !response.ok || response.redirected || response.status < 200 || response.status >= 300) {
    throw new Error('remote_unavailable');
  }
  const text = await boundedText(response);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('remote_malformed');
  }
}

async function boundedText(response) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) throw new Error('response_too_large');
    return text;
  }
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error('response_too_large');
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function createPublishedAcceptanceReader({
  projects,
  fetchImpl = globalThis.fetch,
  resolveCommit,
  now = () => new Date(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
} = {}) {
  if (!projects || typeof fetchImpl !== 'function' ||
      !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000 ||
      !Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    throw new TypeError('Published acceptance reader configuration is invalid');
  }
  const lastGood = new Map();
  const lastStatus = new Map();
  const inFlight = new Map();

  async function requestJson(url) {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': 'Fleet-Tracker' },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return readJson(response);
  }

  async function getCommit(project) {
    const value = resolveCommit
      ? await resolveCommit(project)
      : await requestJson(`https://api.github.com/repos/${project.repository}/commits/${encodeURIComponent(project.branch)}`);
    const sha = typeof value === 'string' ? value : value?.sha;
    if (typeof sha !== 'string' || !SHA_RE.test(sha)) throw new Error('remote_malformed');
    return sha.toLowerCase();
  }

  async function getMatrix(project, commit, path) {
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    const url = `https://raw.githubusercontent.com/${project.repository}/${commit}/${encodedPath}`;
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response || !response.ok || response.redirected || response.status < 200 || response.status >= 300) {
      throw new Error('remote_unavailable');
    }
    const text = await boundedText(response);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('remote_malformed');
    }
  }

  function unavailable(project, checkedAt, reason) {
    const { project_id: projectId } = project;
    const prior = lastGood.get(projectId);
    if (prior && prior.repository === project.repository && prior.branch === project.branch) return structuredClone({
      ...prior,
      checked_at: checkedAt,
      status: 'STALE',
      reason: reason === 'remote_malformed' ? 'published_data_invalid_previous_snapshot_retained'
        : reason === 'response_too_large' ? 'published_response_too_large_previous_snapshot_retained'
          : 'published_sync_failed_previous_snapshot_retained',
    });
    return {
      project_id: projectId,
      repository: project.repository,
      branch: project.branch,
      published_commit: null,
      last_success_at: null,
      checked_at: checkedAt,
      status: 'UNAVAILABLE',
      reason: reason === 'remote_malformed' ? 'published_data_invalid'
        : reason === 'response_too_large' ? 'published_response_too_large' : 'published_sync_failed',
      original: null,
      reference: null,
      requirements: null,
    };
  }

  async function synchronize(project) {
    const { project_id: projectId } = project;
    const checkedAt = timestamp(now);
    try {
      const commit = await getCommit(project);
      const [originalMatrix, referenceMatrix] = await Promise.all([
        getMatrix(project, commit, project.originalPath),
        getMatrix(project, commit, project.referencePath),
      ]);
      if ((project.originalSchema !== undefined && originalMatrix?.schema_version !== project.originalSchema) ||
          (project.referenceSchema !== undefined && referenceMatrix?.schema_version !== project.referenceSchema)) {
        throw new Error('remote_malformed');
      }
      const originalRows = originalMatrix?.requirements;
      const reference = referenceCounts(referenceMatrix);
      const original = matrixCounts(originalRows, project.originalIdField, project.originalResultField);
      const requirements = originalRows.map(row => ({
        id: row[project.originalIdField], status: row[project.originalResultField],
        priority: /^P[0-9]$/.test(row.priority) ? row.priority : null,
        area: /^[a-z][a-z0-9_]{0,79}$/i.test(row.area) ? row.area : null,
      }));
      const succeededAt = timestamp(now);
      const result = {
        project_id: project.project_id,
        repository: project.repository,
        branch: project.branch,
        published_commit: commit,
        last_success_at: succeededAt,
        checked_at: succeededAt,
        status: 'CURRENT',
        reason: 'published_snapshot_refreshed',
        original,
        reference,
        requirements,
      };
      lastGood.set(projectId, structuredClone(result));
      lastStatus.set(projectId, structuredClone(result));
      return structuredClone(result);
    } catch (error) {
      const reason = ['remote_malformed', 'response_too_large'].includes(error?.message)
        ? error.message : 'remote_unavailable';
      const result = unavailable(project, checkedAt, reason);
      lastStatus.set(projectId, structuredClone(result));
      return result;
    }
  }

  async function read(projectId, { refresh = false } = {}) {
    if (typeof refresh !== 'boolean') throw new TypeError('Refresh flag must be boolean');
    const project = safeProject(projectId, projects);
    const pending = inFlight.get(projectId);
    if (pending) return pending;

    const previousStatus = lastStatus.get(projectId);
    const sameProjectRevision = previousStatus &&
      previousStatus.repository === project.repository && previousStatus.branch === project.branch;
    if (!refresh && sameProjectRevision) {
      const nowMs = new Date(timestamp(now)).getTime();
      if (previousStatus.status === 'CURRENT') {
        const age = nowMs - new Date(previousStatus.last_success_at).getTime();
        if (maxAgeMs > 0 && age >= 0 && age < maxAgeMs) {
          return structuredClone(previousStatus);
        }
      } else {
        const retryDelayMs = Math.min(15_000, maxAgeMs);
        const age = nowMs - new Date(previousStatus.checked_at).getTime();
        if (retryDelayMs > 0 && age >= 0 && age < retryDelayMs) {
          return structuredClone(previousStatus);
        }
      }
    }

    const current = synchronize(project).finally(() => {
      if (inFlight.get(projectId) === current) inFlight.delete(projectId);
    });
    inFlight.set(projectId, current);
    return current;
  }

  return {
    read,
    invalidate(projectId) {
      if (projectId === undefined) {
        lastGood.clear();
        lastStatus.clear();
      } else {
        lastGood.delete(projectId);
        lastStatus.delete(projectId);
      }
    },
  };
}

module.exports = { createPublishedAcceptanceReader };
