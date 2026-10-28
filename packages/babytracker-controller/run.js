'use strict';
const { fork } = require('node:child_process');
const path = require('node:path');
function createSupervisor({ forkChild = fork, schedule = setTimeout, cancel = clearTimeout, now = Date.now, log = console.error,
  watchWrapper = process.platform === 'win32' && process.env.BABYTRACKER_FLEET_WRAPPER_WATCH === '1',
  wrapperPid = process.ppid, probeWrapper = pid => process.kill(pid, 0), scheduleWatch = setInterval, cancelWatch = clearInterval } = {}) {
  let child, stopping = false, failures = [], restartTimer = null, started = false, wrapperTimer = null, probeWarning = null;
  function clearTimers() {
    if (restartTimer !== null) { cancel(restartTimer); restartTimer = null; }
    if (wrapperTimer !== null) { cancelWatch(wrapperTimer); wrapperTimer = null; }
  }
  function stop() {
    if (stopping) return;
    stopping = true; clearTimers();
    // This ChildProcess handle is the only termination target. No process-name
    // search, taskkill, daemon stop, or signal to the wrapper PID is used.
    child?.kill('SIGTERM');
  }
  function checkWrapper() {
    if (stopping) return;
    try { probeWrapper(wrapperPid); probeWarning = null; }
    catch (error) {
      const probeCode = error?.code || 'unknown';
      if (probeCode === 'ESRCH') {
        log('BabyTracker task wrapper exited; stopping only the owned controller child.');
        stop();
      } else if (probeWarning !== probeCode) {
        // Permission/unknown errors do not establish parent death.
        probeWarning = probeCode;
        log('BabyTracker wrapper liveness is unverified; no termination was performed.');
      }
    }
  }
  function launch() {
    if (stopping) return;
    let requested = false;
    child = forkChild(path.join(__dirname, 'server.js'), [], { windowsHide: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    child.on('message', msg => { if (msg?.type === 'babytracker-restart') requested = true; });
    child.on('exit', code => {
      if (stopping) return;
      if (code === 0) { clearTimers(); return; }
      if (code === 75 && requested) return launch();
      failures = failures.filter(t => now() - t < 60000); failures.push(now());
      if (failures.length >= 3) { clearTimers(); log('Controller stopped after three startup failures; inspect the log.'); process.exitCode = 1; return; }
      restartTimer = schedule(launch, 2000);
    });
  }
  return {
    start() {
      if (started) throw Error('Supervisor has already started'); started = true;
      if (watchWrapper) {
        if (!Number.isSafeInteger(wrapperPid) || wrapperPid < 1) throw Error('Cannot establish the task wrapper process identity');
        wrapperTimer = scheduleWatch(checkWrapper, 2000); wrapperTimer?.unref?.();
        checkWrapper();
      }
      launch();
    },
    stop
  };
}

if (require.main === module) {
  const supervisor = createSupervisor();
  process.on('SIGINT', () => supervisor.stop()); process.on('SIGTERM', () => supervisor.stop());
  supervisor.start();
}
module.exports = { createSupervisor };
