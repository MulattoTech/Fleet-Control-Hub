'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

const DEFAULT_ROOT = 'C:\\Tools\\Dev\\MJobs';
const ID = /\bMJ-(?:REQ|REF)-[A-Z0-9.]+\b/g;
const SHA = /^[a-f0-9]{40}$/;
const MAX_COMMITS = 1500;

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

function summarize(commits, index, checkpoint, observedMs) {
  const confirmed = new Map();
  const suggested = new Set();
  let merges = 0;
  let mappedCommits = 0;
  let validatedMappedCommits = 0;
  let lastMergeAt = null;
  let commits24h = 0;
  let commitsToday = 0;
  const startToday = Date.UTC(
    new Date(observedMs).getUTCFullYear(),
    new Date(observedMs).getUTCMonth(),
    new Date(observedMs).getUTCDate()
  );

  for (const commit of commits) {
    const time = Date.parse(commit.committedAt);
    if (observedMs - time <= 24 * 60 * 60 * 1000) commits24h++;
    if (time >= startToday) commitsToday++;
    if (commit.merge) {
      merges++;
      if (!lastMergeAt || time > Date.parse(lastMergeAt)) lastMergeAt = commit.committedAt;
    }
    if (commit.confirmed.length) {
      mappedCommits++;
      if (/\bPASS(?:ED)?\b/i.test(commit.validation) && !/^NOT_RUN\b/i.test(commit.validation)) validatedMappedCommits++;
      for (const id of commit.confirmed) {
        const current = confirmed.get(id) || { id, commits: 0, validatedCommits: 0 };
        current.commits++;
        if (/\bPASS(?:ED)?\b/i.test(commit.validation) && !/^NOT_RUN\b/i.test(commit.validation)) current.validatedCommits++;
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

  return {
    available: true,
    observedAt: new Date(observedMs).toISOString(),
    source: 'Local MJobs main Git history + REQUIREMENT_INDEX.json + PROGRESS_CARD.json',
    checkpoint,
    commitsSinceCheckpoint: commits.length,
    commitsLast24h: commits24h,
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
    unmappedCommits: commits.length - mappedCommits,
    requirements: requirementRows
      .sort((a, b) => (a.status === b.status ? a.id.localeCompare(b.id) : a.status.localeCompare(b.status)))
      .slice(0, 200),
    definitions: {
      confirmedMapping: 'Explicit Requirement: trailer on a commit present in local MJobs main after the acceptance checkpoint.',
      suggestedMapping: 'Requirement ID mentioned outside the explicit Requirement: trailer; review required before treating it as linked work.',
      validatedMapping: 'Confirmed mapping with a Validation: trailer containing PASS. This is commit evidence, not canonical acceptance.',
      linkedNotAccepted: 'Confirmed requirement-linked work whose current canonical status is PARTIAL or NOT_RUN. This does not imply the requirement is ready for approval.'
    },
    note: 'Implementation evidence, Git integration, validation trailers and formal acceptance are separate. No acceptance status is changed here.'
  };
}

function createMJobsDevelopment({
  root = process.env.MJOBS_REPO_ROOT || DEFAULT_ROOT,
  clock = Date.now,
  ttlMs = 15_000,
  runGit = null
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
        maxBuffer: 4 * 1024 * 1024
      });
      return result.stdout;
    });
    const mainSha = String(await runner(['rev-parse', 'main'])).trim();
    if (!SHA.test(mainSha)) throw Error('MJobs main revision unavailable');
    const raw = String(await runner([
      'log',
      'main',
      '--since=' + checkpoint.asOf,
      '--max-count=' + MAX_COMMITS,
      '--pretty=format:%H%x1f%cI%x1f%s%x1f%b%x1e'
    ]));
    const commits = raw.split('\x1e').map(parseRecord).filter(Boolean);
    const result = summarize(commits, index, checkpoint, observed);
    result.mainSha = mainSha;
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
  summarize
};
