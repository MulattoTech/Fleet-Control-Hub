'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');
const { configFromEnvironment } = require('./config');
const { AOAdapter, quotaSnapshot } = require('./adapter');
const { FleetController } = require('./controller');
const { NativeModelSwitch } = require('./model-switch');
const { createSharedProviders } = require('./multi-provider');
const { createProjectHub } = require('./project-hub');

function acquireLock(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'controller.lock');
  const record = { pid: process.pid, nonce: randomUUID() };
  try { fs.writeFileSync(file, JSON.stringify(record), { flag: 'wx', mode: 0o600 }); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // Serialize stale-lock recovery. Without this lock, two contenders could each
    // unlink the other's replacement between read/compare and exclusive creation.
    const recovery = path.join(directory, 'controller-recovery.lock');
    try { fs.writeFileSync(recovery, record.nonce, { flag: 'wx', mode: 0o600 }); }
    catch { throw Error('Controller lock recovery is already in progress; inspect a stale recovery lock before retrying'); }
    try {
      let previous; try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw Error('Controller lock is unreadable; inspect it before restarting'); }
      if (!Number.isSafeInteger(previous.pid) || previous.pid < 1) throw Error('Controller lock is invalid');
      try { process.kill(previous.pid, 0); throw Error('A controller with this state directory is already running'); }
      catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
      fs.unlinkSync(file);
      fs.writeFileSync(file, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    } finally { if (fs.readFileSync(recovery, 'utf8') === record.nonce) fs.unlinkSync(recovery); }
  }
  return () => {
    try { if (JSON.parse(fs.readFileSync(file, 'utf8')).nonce === record.nonce) fs.unlinkSync(file); } catch {}
  };
}

function json(res, code, value) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value));
}

function createServer({ config, controller, onRestart = null, projectsReader = async () => ({ projects: [] }) }) {
  const token = randomBytes(32).toString('hex');
  const staticFiles = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/mjobs-style.css': ['mjobs-style.css', 'text/css; charset=utf-8'], '/babytracker.css': ['babytracker.css', 'text/css; charset=utf-8'], '/projects': ['projects.html', 'text/html; charset=utf-8'], '/projects.js': ['projects.js', 'text/javascript; charset=utf-8'] };
  let closing = false;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const port = req.socket.localPort;
    const hosts = ['127.0.0.1:' + port, 'localhost:' + port];
    if (!hosts.includes(req.headers.host) || req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Local origin required' });
    try {
      const url = new URL(req.url, 'http://127.0.0.1:' + port);
      if (req.method === 'GET') {
        if (url.pathname === '/api/health') return json(res, 200, { status: 'ok', projectId: config.projectId, mode: controller.state.mode, spendingOnPageLoad: false });
        if (url.pathname === '/api/session') return json(res, 200, { token });
        if (url.pathname === '/api/state') return json(res, 200, await controller.snapshot());
        if (url.pathname === '/api/providers') return json(res, 200, await controller.providers());
        if (url.pathname === '/api/projects') return json(res, 200, await projectsReader());
        const item = staticFiles[url.pathname];
        if (item) { res.writeHead(200, { 'Content-Type': item[1] }); return res.end(fs.readFileSync(path.join(__dirname, 'public', item[0]))); }
        return json(res, 404, { error: 'Not found' });
      }
      if (req.method !== 'POST' || url.pathname !== '/api/action') return json(res, 405, { error: 'Method not allowed' });
      if (!hosts.map(h => 'http://' + h).includes(req.headers.origin)) return json(res, 403, { error: 'Same-origin action required' });
      const candidate = String(req.headers['x-babytracker-fleet'] || '');
      if (candidate.length !== token.length || !timingSafeEqual(Buffer.from(candidate), Buffer.from(token))) return json(res, 403, { error: 'Invalid local action token' });
      if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'JSON required' });
      let bytes = 0, chunks = [];
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 20000) return json(res, 413, { error: 'Action too large' }); chunks.push(chunk); }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!input || Array.isArray(input) || typeof input !== 'object') throw Error('Action object required');
      if (closing) return json(res, 409, { error: 'Controller is restarting' });
      let result;
      switch (input.action) {
        case 'reconcile-bootstrap': result = await controller.reconcileBootstrap(input.confirm); break;
        case 'start': result = await controller.start(); break;
        case 'pause': result = controller.pause(); break;
        case 'drain': result = await controller.stop(false); break;
        case 'emergency': result = await controller.stop(true); break;
        case 'release': result = await controller.releaseEmergency(); break;
        case 'nudge': result = await controller.dispatch(input.id, 'nudge', { manualAgy: input.acknowledgeUnknownAgyQuota === true }); break;
        case 'find-work': result = await controller.dispatch(input.id, 'find-work', { manualAgy: input.acknowledgeUnknownAgyQuota === true }); break;
        case 'add-agent': result = await controller.addAgent(input.agent); break;
        case 'reconcile-agent': result = await controller.reconcileAgentSpawn({ confirmNoSession: input.confirmNoSession === true }); break;
        case 'all-hands': result = await controller.allHands(); break;
        case 'turbo': result = controller.turbo(input.enabled); break;
        case 'limits': result = controller.limits(input.limits); break;
        case 'quota-policy': result = await controller.updateQuotaPolicy(input.minimumRemainingPercent); break;
        case 'concurrency-policy': result = await controller.updateConcurrency(input.concurrency); break;
        case 'task': result = controller.enqueue(input.task); break;
        case 'assign': result = await controller.assign(input.taskId, input.agentId); break;
        case 'assess-task': result = await controller.assessTask(input.taskId, input); break;
        case 'model-plan': throw Error('Staging-only model plans are no longer supported. Reload this dashboard and use Change model to apply a real native AO change.');
        case 'model-change': result = await controller.changeModel(input.id, input.plan); break;
        case 'model-cancel': result = await controller.cancelModelChange(input.id); break;
        case 'model-reconcile': result = await controller.reconcileModelChange(input.id); break;
        case 'model-resume': result = await controller.resumeModelChange(input.id); break;
        case 'restart':
          if (!onRestart) throw Error('Controller was started without the restart supervisor. Start it with run.js.');
          controller.pause('Controller restart'); closing = true;
          json(res, 200, { ok: true, note: 'Controller restarting; dispatch will remain paused.' });
          setImmediate(onRestart); return;
        default: throw Error('Unsupported action');
      }
      json(res, 200, result);
    } catch (e) { json(res, 409, { error: String(e.message).slice(0, 500) }); }
  });
  server.requestTimeout = 70000;
  server.headersTimeout = 10000;
  return server;
}

function main() {
  const config = configFromEnvironment();
  const release = acquireLock(config.stateDir);
  const providers = createSharedProviders(config);
  const controller = new FleetController(config, { adapter: new AOAdapter(config), quota: () => quotaSnapshot(config.quotaFile), nativeModel: new NativeModelSwitch(config), agyUsage: () => providers.usage(), providers: async () => {
    const value = await providers.get();
    return { ...value, source: 'MJobs Codex catalog (read-only); AGY static adapter-supported models, not live/account-verified. Background CLI probes are disabled; explicit agent controls are unchanged.' };
  } });
  let ending = false;
  const stop = code => {
    if (ending) return; ending = true;
    clearInterval(timer); controller.pause('Controller shutdown');
    server.close(() => { release(); process.exit(code); });
    setTimeout(() => { release(); process.exit(code); }, 5000).unref();
  };
  const server = createServer({ config, controller, projectsReader: createProjectHub(config, controller), onRestart: process.send ? () => { process.send({ type: 'babytracker-restart' }); stop(75); } : null });
  const timer = setInterval(() => controller.tick(), 5000); timer.unref();
  server.on('error', e => { release(); console.error('BabyTracker Fleet: ' + e.message); process.exitCode = 1; clearInterval(timer); });
  process.on('SIGINT', () => stop(0)); process.on('SIGTERM', () => stop(0));
  process.on('exit', release);
  server.listen(config.port, '127.0.0.1', () => console.log('BabyTracker Fleet Control: http://127.0.0.1:' + config.port + ' (dispatch paused)'));
}

if (require.main === module) main();
module.exports = { createServer, acquireLock };
