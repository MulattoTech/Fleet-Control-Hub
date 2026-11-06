'use strict';

// A reviewed historical rejection is different from a verified empty fleet.
// This proof retires only an attempt that never committed RestoreFleet's durable
// run record. It neither launches agents nor asserts that unrelated agents stopped.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const HASH = /^[a-f0-9]{64}$/;
const ERROR = 'Bounded restore requires only the saved MJobs primary and dispatch off';
const sameIds = (a,b) => Array.isArray(a) && Array.isArray(b) && new Set(a).size === a.length && new Set(b).size === b.length && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
function readArchive(root, item) {
  if (!item || !HASH.test(item.sha256 || '') || typeof item.path !== 'string' || path.isAbsolute(item.path)) throw Error('Invalid archive reference');
  const base = fs.realpathSync(path.join(root, 'backups'));
  const file = fs.realpathSync(path.resolve(root, item.path));
  const relative = path.relative(base, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('Archive must be inside backups');
  const bytes = fs.readFileSync(file);
  if (sha(bytes) !== item.sha256) throw Error('Archive changed');
  return { bytes, value: JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,'')), stat: fs.statSync(file) };
}
function validLegacyEvidence(previous, evidence) {
  return evidence?.type === 'archived-precommit-rejection' && evidence.version === 1 &&
    evidence.runId === previous.runId && evidence.stateRevision === previous.revision &&
    evidence.manifestRevision === previous.bootstrap?.manifestRevision &&
    evidence.primaryId === previous.options?.boundedPrimaryId &&
    evidence.ledgerPredatesAttempt === true && evidence.ledgerUnchanged === true &&
    evidence.exactArchivedAttempt === true && evidence.exactArchivedManifest === true &&
    evidence.auditMatches === true && evidence.startCommitted === false &&
    ['reviewSha256','startupSha256','snapshotSha256','ledgerSha256'].every(k => HASH.test(evidence[k] || '')) &&
    previous.options?.expectedProjectId === 'mjobs-luna' &&
    previous.options?.startWorkAfter === false && previous.options?.autoDispatchAfter === false &&
    /^mjobs-luna-[0-9]+$/.test(evidence.primaryId || '') &&
    previous.bootstrap?.targetCount === 1 && sameIds(previous.bootstrap?.targetIds, [evidence.primaryId]) &&
    previous.error?.code === 'STARTUP_FAILED' && previous.error?.message === ERROR &&
    previous.restoreStartAttempted === true && previous.restoreStarted === false && previous.restoreReceipt === null &&
    previous.actionPending?.name === 'start existing RestoreFleet';
}
function inspectLegacyEvidence({ root, previous, restoreState, manifestFromSnapshot, now = Date.now() }) {
  try {
    if (!previous || previous.restoreBefore || previous.active !== false || previous.phase !== 'uncertain' || previous.reconciliationRequired !== true) return null;
    const reviewBytes = fs.readFileSync(path.join(root, 'startup-legacy-review.json'));
    const review = JSON.parse(reviewBytes.toString('utf8').replace(/^\uFEFF/,''));
    if (review.version !== 1 || review.runId !== previous.runId || review.stateRevision !== previous.revision) return null;
    const startupBytes = fs.readFileSync(path.join(root, 'startup-state.json'));
    if (sha(startupBytes) !== review.startupSha256) return null;
    const archivedStartup = readArchive(root, review.archivedStartup);
    if (sha(archivedStartup.bytes) !== sha(startupBytes)) return null;
    const snapshot = readArchive(root, review.snapshot), ledger = readArchive(root, review.ledger);
    const currentLedger = fs.readFileSync(path.join(root, 'restore-state.json'));
    if (sha(currentLedger) !== sha(ledger.bytes)) return null;
    const disk = JSON.parse(currentLedger.toString('utf8').replace(/^\uFEFF/,''));
    const normalized = value => ({ ...value, branchAdoptionReceipts:value.branchAdoptionReceipts || {}, postRestoreReviewReceipts:value.postRestoreReviewReceipts || {} });
    if (!isDeepStrictEqual(normalized(disk), normalized(restoreState))) return null;
    if (disk.active !== false || disk.phase !== 'complete' || !disk.source?.startupRunId || disk.source.startupRunId === previous.runId ||
        !disk.inflight || Object.keys(disk.inflight).length || !disk.errors || Object.keys(disk.errors).length ||
        !sameIds(disk.desiredIds, disk.source?.targets?.map(s => s.id))) return null;
    const stages = previous.events?.filter(e => e.phase === 'starting_restore') || [];
    const times = [disk.startedAt, disk.completedAt, previous.startedAt, stages[0]?.at, previous.actionPending?.startedAt, previous.finishedAt].map(Date.parse);
    if (stages.length !== 1 || previous.events.at(-1)?.phase !== 'starting_restore' || !times.every(Number.isFinite) ||
        !times.every((v,i) => i === 0 || v >= times[i-1]) || times[5] > now || ledger.stat.birthtimeMs >= times[2] ||
        previous.cleanup?.active !== false || !['hold dispatch','pause restore'].every(name => previous.cleanup.outcomes?.some(o => o.name === name && o.ok === true))) return null;
    const manifest = manifestFromSnapshot(snapshot.value, previous.options?.expectedProjectId, previous.options?.boundedPrimaryId);
    if (manifest.revision !== previous.bootstrap?.manifestRevision || !sameIds(manifest.targets.map(s => s.id), previous.bootstrap?.targetIds)) return null;
    const events = fs.readFileSync(path.join(root,'audit.jsonl'),'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).filter(e => e.runId === previous.runId);
    const requested = events.filter(e => e.event === 'startup_requested'), failed = events.filter(e => e.event === 'startup_failed');
    const started = events.filter(e => e.event === 'startup_phase' && e.phase === 'starting_restore');
    if (requested.length !== 1 || failed.length !== 1 || started.length !== 1 || requested[0].time !== previous.startedAt ||
        started[0].time !== stages[0].at || failed[0].phase !== 'uncertain' || failed[0].code !== 'STARTUP_FAILED' ||
        Date.parse(failed[0].time) < times[5] || Date.parse(failed[0].time) - times[5] > 1000 ||
        events.some(e => e.event === 'startup_phase' && ['restoring','verifying','starting_dispatch'].includes(e.phase))) return null;
    const proof = { version:1, type:'archived-precommit-rejection', runId:previous.runId, stateRevision:previous.revision,
      primaryId:previous.options.boundedPrimaryId, manifestRevision:manifest.revision,
      reviewSha256:sha(reviewBytes), startupSha256:sha(startupBytes), snapshotSha256:sha(snapshot.bytes), ledgerSha256:sha(currentLedger),
      ledgerPredatesAttempt:true, ledgerUnchanged:true, exactArchivedAttempt:true, exactArchivedManifest:true,
      auditMatches:true, startCommitted:false };
    return validLegacyEvidence(previous,proof) ? proof : null;
  } catch { return null; }
}
module.exports = { inspectLegacyEvidence, validLegacyEvidence };
