'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

const DEFAULT_ROOT = 'C:\\Tools\\Dev\\MJobs';
const ID = /\bMJ-(?:REQ|REF)-[A-Z0-9.]+\b/g;
const SHA = /^[a-f0-9]{40}$/;
const MAX_COMMITS = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_SCHEMA = 1;
const HISTORY_INTERVAL_MS = 15 * 60 * 1000;
const HISTORY_BASELINE_TOLERANCE_MS = 2 * HISTORY_INTERVAL_MS;
const HISTORY_RETENTION_MS = 30 * DAY_MS;
const HISTORY_MAX_SNAPSHOTS = 3000;
const HISTORY_MAX_BYTES = 1_000_000;
const WINDOW_DEFS = [
  { key: 'hour', label: 'Last hour', ms: 60 * 60 * 1000 },
  { key: 'day', label: 'Last 24 hours', ms: DAY_MS },
  { key: 'week', label: 'Last 7 days', ms: 7 * DAY_MS }
];

function readJSON(file, maxBytes = 5_000_000) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > maxBytes) {
    throw Error('MJobs evidence file unavailable');
  }
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function requirementIndex(root) {
  const raw = readJSON(path.join(root, 'planning', 'REQUIREMENT_INDEX.json'));
  if (raw?.schema_version !== 1 || !Array.isArray(raw.requirements) || raw.requirements.length > 1000) {
    throw Error('Requirement index contract changed');
  }
  const map = new Map();
  for (const item of raw.requirements) {
    if (!item || typeof item.id !== 'string' || !/^(?:MJ-REQ|MJ-REF)-[A-Z0-9.]+$/.test(item.id)) continue;
    map.set(item.id, {
      status: ['PASS', 'PARTIAL', 'NOT_RUN'].includes(item.status) ? item.status : 'UNKNOWN',
      issue: Number.isSafeInteger(item.issue) ? item.issue : null,
      priority: typeof item.priority === 'string' ? item.priority.slice(0, 16) : null,
      area: typeof item.area === 'string' ? item.area.slice(0, 80) : null
    });
  }
  return map;
}

function acceptanceCheckpoint(root) {
  const card = readJSON(path.join(root, 'docs', 'PROGRESS_CARD.json'), 100_000);
  const asOf = card?.original?.as_of;
  if (typeof asOf !== 'string' || !Number.isFinite(Date.parse(asOf))) throw Error('Acceptance checkpoint unavailable');
  return {
    asOf,
    pass: Number.isSafeInteger(card?.original?.pass) ? card.original.pass : null,
    total: Number.isSafeInteger(card?.original?.total) ? card.original.total : null
  };
}

function parseRecord(record) {
  record = String(record).replace(/^(?:\r?\n)+/, '');
  const parts = record.split('\x1f');
  if (parts.length < 4) return null;
  const [sha, committedAt, subject, ...bodyParts] = parts;
  const body = bodyParts.join('\x1f');
  if (!SHA.test(sha) || !Number.isFinite(Date.parse(committedAt))) return null;
  const confirmed = new Set();
  const suggested = new Set();
  for (const line of body.split(/\r?\n/)) {
    const match = /^Requirement:\s*(.+)$/i.exec(line.trim());
    if (match) for (const id of match[1].match(ID) || []) confirmed.add(id);
  }
  for (const id of (subject + '\n' + body).match(ID) || []) {
    if (!confirmed.has(id)) suggested.add(id);
  }
  const validationLine = body.split(/\r?\n/).find(line => /^Validation:/i.test(line.trim())) || '';
  const validation = validationLine.replace(/^Validation:\s*/i, '').trim();
  return {
    sha,
    committedAt,
    subject: subject.slice(0, 220),
    confirmed: [...confirmed],
    suggested: [...suggested],
    validation,
    merge: /^Merge pull request #\d+/i.test(subject) || /^Merge PR #\d+/i.test(subject)
  };
}

function validationPassed(commit) {
  return /\bPASS(?:ED)?\b/i.test(commit.validation) && !/^NOT_RUN\b/i.test(commit.validation);
}

function summarizeWindow(commits, index, observedMs, def) {
  const sinceMs = observedMs - def.ms;
  const rows = commits.filter(commit => Date.parse(commit.committedAt) >= sinceMs);
  const touched = new Set();
  const validated = new Set();
  let merges = 0;
  let mappedCommits = 0;
  let validatedMappedCommits = 0;

  for (const commit of rows) {
    if (commit.merge) merges++;
    if (commit.confirmed.length) {
      mappedCommits++;
      if (validationPassed(commit)) validatedMappedCommits++;
      for (const id of commit.confirmed) {
        touched.add(id);
        if (validationPassed(commit)) validated.add(id);
      }
    }
  }

  return {
    label: def.label,
    since: new Date(sinceMs).toISOString(),
    through: new Date(observedMs).toISOString(),
    commits: rows.length,
    mergeCommits: merges,
    requirementLinkedCommits: mappedCommits,
    validatedRequirementLinkedCommits: validatedMappedCommits,
    requirementsWithIntegratedWork: touched.size,
    requirementsWithValidatedWork: validated.size,
    linkedStillNotAccepted: [...touched].filter(id => {
      const status = index.get(id)?.status;
      return status === 'PARTIAL' || status === 'NOT_RUN';
    }).length,
    unmappedCommits: rows.length - mappedCommits,
    basis: 'Commit timestamps observed on canonical main; formal acceptance is separate.'
  };
}

function summarize(commits, index, checkpoint, observedMs) {
  const checkpointMs = Date.parse(checkpoint.asOf);
  const checkpointCommits = commits.filter(commit => Date.parse(commit.committedAt) >= checkpointMs);
  const confirmed = new Map();
  const suggested = new Set();
  let merges = 0;
  let mappedCommits = 0;
  let validatedMappedCommits = 0;
  let lastMergeAt = null;
  let commitsToday = 0;
  const startToday = Date.UTC(
    new Date(observedMs).getUTCFullYear(),
    new Date(observedMs).getUTCMonth(),
    new Date(observedMs).getUTCDate()
  );

  for (const commit of checkpointCommits) {
    const time = Date.parse(commit.committedAt);
    if (time >= startToday) commitsToday++;
    if (commit.merge) {
      merges++;
      if (!lastMergeAt || time > Date.parse(lastMergeAt)) lastMergeAt = commit.committedAt;
    }
    if (commit.confirmed.length) {
      mappedCommits++;
      if (validationPassed(commit)) validatedMappedCommits++;
      for (const id of commit.confirmed) {
        const current = confirmed.get(id) || { id, commits: 0, validatedCommits: 0 };
        current.commits++;
        if (validationPassed(commit)) current.validatedCommits++;
        confirmed.set(id, current);
      }
    }
    for (const id of commit.suggested) suggested.add(id);
  }

  const requirementRows = [...confirmed.values()].map(row => {
    const meta = index.get(row.id);
    return {
      ...row,
      status: meta?.status || 'UNKNOWN',
      issue: meta?.issue ?? null,
      priority: meta?.priority ?? null,
      area: meta?.area ?? null
    };
  });
  const byStatus = { PASS: 0, PARTIAL: 0, NOT_RUN: 0, UNKNOWN: 0 };
  for (const row of requirementRows) byStatus[row.status] = (byStatus[row.status] || 0) + 1;
  const validatedRequirements = requirementRows.filter(row => row.validatedCommits > 0).length;
  const linkedNotAccepted = requirementRows.filter(row => row.status === 'PARTIAL' || row.status === 'NOT_RUN').length;
  const activityWindows = Object.fromEntries(
    WINDOW_DEFS.map(def => [def.key, summarizeWindow(commits, index, observedMs, def)])
  );

  return {
    available: true,
    observedAt: new Date(observedMs).toISOString(),
    source: 'Local MJobs main Git history + REQUIREMENT_INDEX.json + PROGRESS_CARD.json',
    checkpoint,
    commitsSinceCheckpoint: checkpointCommits.length,
    commitsLast24h: activityWindows.day.commits,
    commitsToday,
    mergeCommitsSinceCheckpoint: merges,
    lastMergeAt,
    requirementLinkedCommits: mappedCommits,
    validatedRequirementLinkedCommits: validatedMappedCommits,
    confirmedRequirementMappings: requirementRows.length,
    validatedRequirementMappings: validatedRequirements,
    linkedNotAccepted,
    mappingStatus: byStatus,
    suggestedRequirementMappings: suggested.size,
    unmappedCommits: checkpointCommits.length - mappedCommits,
    activityWindows,
    requirements: requirementRows
      .sort((a, b) => (a.status === b.status ? a.id.localeCompare(b.id) : a.status.localeCompare(b.status)))
      .slice(0, 200),
    definitions: {
      confirmedMapping: 'Explicit Requirement: trailer on a commit present in local MJobs main after the acceptance checkpoint.',
      suggestedMapping: 'Requirement ID mentioned outside the explicit Requirement: trailer; review required before treating it as linked work.',
      validatedMapping: 'Confirmed mapping with a Validation: trailer containing PASS. This is commit evidence, not canonical acceptance.',
      linkedNotAccepted: 'Confirmed requirement-linked work whose current canonical status is PARTIAL or NOT_RUN. This does not imply the requirement is ready for approval.',
      activityWindow: 'Rolling activity uses commit timestamps already present on canonical main. It does not infer pre-merge development time or acceptance.'
    },
    note: 'Implementation evidence, Git integration, validation trailers and formal acceptance are separate. No acceptance status is changed here.'
  };
}

function defaultHistoryFile() {
  if (process.env.FLEET_HUB_MJOBS_DEVELOPMENT_HISTORY) {
    return path.resolve(process.env.FLEET_HUB_MJOBS_DEVELOPMENT_HISTORY);
  }
  const base = process.env.LOCALAPPDATA;
  return base ? path.join(base, 'FleetControlHub', 'mjobs-development-history.json') : null;
}

function historySnapshot(result) {
  return {
    observedAt: result.observedAt,
    mainSha: result.mainSha,
    mainCommitCount: result.mainCommitCount,
    checkpointAsOf: result.checkpoint?.asOf,
    acceptancePass: result.checkpoint?.pass,
    acceptanceTotal: result.checkpoint?.total,
    commitsSinceCheckpoint: result.commitsSinceCheckpoint,
    mergeCommitsSinceCheckpoint: result.mergeCommitsSinceCheckpoint,
    confirmedRequirementMappings: result.confirmedRequirementMappings,
    validatedRequirementMappings: result.validatedRequirementMappings,
    linkedNotAccepted: result.linkedNotAccepted,
    unmappedCommits: result.unmappedCommits
  };
}

function normalizeHistorySnapshot(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.observedAt !== 'string' || !Number.isFinite(Date.parse(value.observedAt))) return null;
  if (!SHA.test(String(value.mainSha || ''))) return null;
  if (typeof value.checkpointAsOf !== 'string' || !Number.isFinite(Date.parse(value.checkpointAsOf))) return null;
  const numeric = [
    'mainCommitCount', 'acceptancePass', 'acceptanceTotal', 'commitsSinceCheckpoint',
    'mergeCommitsSinceCheckpoint', 'confirmedRequirementMappings', 'validatedRequirementMappings',
    'linkedNotAccepted', 'unmappedCommits'
  ];
  for (const key of numeric) if (!Number.isSafeInteger(value[key]) || value[key] < 0) return null;
  return {
    observedAt: value.observedAt,
    mainSha: value.mainSha,
    mainCommitCount: value.mainCommitCount,
    checkpointAsOf: value.checkpointAsOf,
    acceptancePass: value.acceptancePass,
    acceptanceTotal: value.acceptanceTotal,
    commitsSinceCheckpoint: value.commitsSinceCheckpoint,
    mergeCommitsSinceCheckpoint: value.mergeCommitsSinceCheckpoint,
    confirmedRequirementMappings: value.confirmedRequirementMappings,
    validatedRequirementMappings: value.validatedRequirementMappings,
    linkedNotAccepted: value.linkedNotAccepted,
    unmappedCommits: value.unmappedCommits
  };
}

function readHistorySnapshots(file) {
  if (!file || !fs.existsSync(file)) return [];
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > HISTORY_MAX_BYTES) {
    throw Error('Development history unavailable');
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (raw?.version !== HISTORY_SCHEMA || !Array.isArray(raw.snapshots) || raw.snapshots.length > HISTORY_MAX_SNAPSHOTS) {
    throw Error('Development history contract changed');
  }
  return raw.snapshots.map(normalizeHistorySnapshot).filter(Boolean)
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
}

function sameHistoryMetrics(a, b) {
  return a.mainSha === b.mainSha &&
    a.mainCommitCount === b.mainCommitCount &&
    a.checkpointAsOf === b.checkpointAsOf &&
    a.acceptancePass === b.acceptancePass &&
    a.acceptanceTotal === b.acceptanceTotal &&
    a.commitsSinceCheckpoint === b.commitsSinceCheckpoint &&
    a.mergeCommitsSinceCheckpoint === b.mergeCommitsSinceCheckpoint &&
    a.confirmedRequirementMappings === b.confirmedRequirementMappings &&
    a.validatedRequirementMappings === b.validatedRequirementMappings &&
    a.linkedNotAccepted === b.linkedNotAccepted &&
    a.unmappedCommits === b.unmappedCommits;
}

function writeHistorySnapshots(file, snapshots, observedMs) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const dirStat = fs.lstatSync(dir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw Error('Development history directory unavailable');
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Development history file unavailable');
  }
  const temp = file + '.tmp-' + process.pid + '-' + observedMs;
  const payload = JSON.stringify({ version: HISTORY_SCHEMA, snapshots });
  if (Buffer.byteLength(payload, 'utf8') > HISTORY_MAX_BYTES) throw Error('Development history too large');
  try {
    fs.writeFileSync(temp, payload, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temp, file);
  } catch (error) {
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch {}
    throw error;
  }
}

function recordHistorySnapshot(file, result, observedMs, intervalMs = HISTORY_INTERVAL_MS) {
  if (!file) {
    return {
      metadata: { available: false, persistent: false, reason: 'Durable Hub history is not configured.' },
      snapshots: []
    };
  }
  const current = normalizeHistorySnapshot(historySnapshot(result));
  if (!current) throw Error('Current development snapshot is invalid');
  let snapshots = readHistorySnapshots(file);
  const last = snapshots.at(-1) || null;
  const lastMs = last ? Date.parse(last.observedAt) : 0;
  const changed = !last || !sameHistoryMetrics(last, current);
  const shouldRecord = changed || observedMs - lastMs >= intervalMs;
  if (shouldRecord) {
    const cutoff = observedMs - HISTORY_RETENTION_MS;
    snapshots = [...snapshots, current]
      .filter(item => Date.parse(item.observedAt) >= cutoff)
      .slice(-HISTORY_MAX_SNAPSHOTS);
    writeHistorySnapshots(file, snapshots, observedMs);
  }
  const final = snapshots.at(-1) || current;
  return {
    metadata: {
      available: true,
      persistent: true,
      sampleCount: snapshots.length,
      oldestObservedAt: snapshots[0]?.observedAt || current.observedAt,
      newestObservedAt: final.observedAt,
      recorded: shouldRecord
    },
    snapshots
  };
}

function buildHistoryDeltas(snapshots, result, observedMs) {
  const current = normalizeHistorySnapshot(historySnapshot(result));
  const safe = Array.isArray(snapshots) ? snapshots.map(normalizeHistorySnapshot).filter(Boolean) : [];
  const output = {};
  for (const def of WINDOW_DEFS) {
    const cutoff = observedMs - def.ms;
    const baseline = [...safe].reverse().find(item => Date.parse(item.observedAt) <= cutoff);
    const baselineGapMs = baseline ? cutoff - Date.parse(baseline.observedAt) : Number.POSITIVE_INFINITY;
    if (!baseline || baselineGapMs > HISTORY_BASELINE_TOLERANCE_MS) {
      output[def.key] = {
        available: false,
        label: def.label,
        reason: 'Durable history does not yet have a sufficiently close baseline for this comparison window.'
      };
      continue;
    }
    const sameCheckpoint = baseline.checkpointAsOf === current.checkpointAsOf;
    const mainCommitDelta = current.mainCommitCount >= baseline.mainCommitCount
      ? current.mainCommitCount - baseline.mainCommitCount
      : null;
    output[def.key] = {
      available: true,
      label: def.label,
      baselineAt: baseline.observedAt,
      through: current.observedAt,
      mainCommitDelta,
      mainChanged: baseline.mainSha !== current.mainSha,
      acceptancePassDelta: current.acceptancePass - baseline.acceptancePass,
      acceptanceFrom: baseline.acceptancePass,
      acceptanceTo: current.acceptancePass,
      checkpointChanged: !sameCheckpoint,
      requirementMappingsDelta: sameCheckpoint
        ? current.confirmedRequirementMappings - baseline.confirmedRequirementMappings
        : null,
      validatedMappingsDelta: sameCheckpoint
        ? current.validatedRequirementMappings - baseline.validatedRequirementMappings
        : null,
      linkedNotAcceptedDelta: sameCheckpoint
        ? current.linkedNotAccepted - baseline.linkedNotAccepted
        : null,
      note: sameCheckpoint
        ? 'Exact delta between sanitized Hub observations; formal acceptance remains canonical.'
        : 'Acceptance checkpoint changed inside this window; checkpoint-scoped development deltas are not subtracted across the reset.'
    };
  }
  return output;
}

function createMJobsDevelopment({
  root = process.env.MJOBS_REPO_ROOT || DEFAULT_ROOT,
  clock = Date.now,
  ttlMs = 15_000,
  runGit = null,
  historyFile = null,
  historyIntervalMs = HISTORY_INTERVAL_MS
} = {}) {
  let snapshot = null;
  let expiresAt = 0;
  let pending = null;

  async function collect() {
    const observed = clock();
    const checkpoint = acceptanceCheckpoint(root);
    const index = requirementIndex(root);
    const runner = runGit || (async args => {
      const result = await execFileAsync('git', ['-C', root, ...args], {
        windowsHide: true,
        timeout: 4000,
        maxBuffer: 8 * 1024 * 1024
      });
      return result.stdout;
    });
    const mainSha = String(await runner(['rev-parse', 'main'])).trim();
    if (!SHA.test(mainSha)) throw Error('MJobs main revision unavailable');
    const mainCommitCount = Number.parseInt(String(await runner(['rev-list', '--count', 'main'])).trim(), 10);
    if (!Number.isSafeInteger(mainCommitCount) || mainCommitCount < 1) throw Error('MJobs main commit count unavailable');

    const checkpointMs = Date.parse(checkpoint.asOf);
    const historyFromMs = Math.min(checkpointMs, observed - 7 * DAY_MS);
    const raw = String(await runner([
      'log',
      'main',
      '--since=' + new Date(historyFromMs).toISOString(),
      '--max-count=' + MAX_COMMITS,
      '--pretty=format:%H%x1f%cI%x1f%s%x1f%b%x1e'
    ]));
    const commits = raw.split('\x1e').map(parseRecord).filter(Boolean);
    if (commits.length >= MAX_COMMITS) throw Error('MJobs development history exceeds bounded scan');
    const result = summarize(commits, index, checkpoint, observed);
    result.mainSha = mainSha;
    result.mainCommitCount = mainCommitCount;

    if (historyFile) {
      try {
        const history = recordHistorySnapshot(historyFile, result, observed, historyIntervalMs);
        result.history = history.metadata;
        result.observedDeltas = buildHistoryDeltas(history.snapshots, result, observed);
      } catch {
        result.history = {
          available: false,
          persistent: true,
          reason: 'Durable Hub history could not be updated; live development evidence remains available.'
        };
        result.observedDeltas = buildHistoryDeltas([], result, observed);
      }
    } else {
      result.history = { available: false, persistent: false, reason: 'Durable Hub history is disabled for this process.' };
      result.observedDeltas = buildHistoryDeltas([], result, observed);
    }
    return result;
  }

  async function status() {
    if (pending) return pending;
    if (snapshot && clock() < expiresAt) return snapshot;
    pending = (async () => {
      try {
        snapshot = await collect();
        expiresAt = clock() + ttlMs;
      } catch {
        snapshot = {
          available: false,
          observedAt: new Date(clock()).toISOString(),
          reason: 'Local MJobs development evidence is unavailable; no implementation counts are inferred.'
        };
        expiresAt = clock() + Math.min(ttlMs, 5000);
      } finally {
        pending = null;
      }
      return snapshot;
    })();
    return pending;
  }

  return { status };
}

module.exports = {
  createMJobsDevelopment,
  parseRecord,
  summarize,
  defaultHistoryFile,
  recordHistorySnapshot,
  buildHistoryDeltas
};
