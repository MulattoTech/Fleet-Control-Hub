'use strict';
// One configurable start/new-work limit, separate from emergency termination.
const DEFAULT_MINIMUM = 0;
function minimumRemaining(config = {}) {
  if (config.minimumRemainingPercent === undefined) return DEFAULT_MINIMUM;
  const value = config.minimumRemainingPercent;
  return Number.isInteger(value) && value >= 0 && value <= 99 ? value : 100;
}
function policyStatus(config, sample) {
  const limit = minimumRemaining(config), stop = Number.isInteger(config.thresholdPercent) ? config.thresholdPercent : 7;
  const remaining = sample.selectedRemainingPercent;
  const fresh = sample.fresh === true && Number.isFinite(remaining) && remaining >= 0 && remaining <= 100;
  const emergencyBlocked = config.autoKillArmed === true && remaining <= stop;
  const blocked = !fresh || remaining <= limit || emergencyBlocked || sample.ordinaryUsageAllowed === false;
  return { minimumRemainingPercent: limit, emergencyStopPercent: stop, remainingPercent: fresh ? remaining : null,
    fresh, blocked, configurable: true, comparison: 'remaining must be greater than the start/new-work limit',
    reason: !fresh ? 'Quota unavailable or stale; new work is blocked.' : sample.ordinaryUsageAllowed === false ? 'Provider usage is unavailable.' :
      emergencyBlocked ? `Armed emergency threshold reached at ${remaining}% remaining (${stop}% stop).` :
      remaining <= limit ? `QUOTA HOLD: ${remaining}% remaining; start/new work requires more than ${limit}%. ${config.autoKillArmed ? 'Optional emergency stop: '+stop+'%.' : 'Normal Start uses the saved reserve without arming automatic termination.'}` :
        `${remaining}% remaining; start/new work allowed above ${limit}%. ${config.autoKillArmed ? 'Optional emergency stop: '+stop+'%.' : 'Automatic emergency termination is disarmed.'}` };
}
module.exports = { DEFAULT_MINIMUM, minimumRemaining, policyStatus };
