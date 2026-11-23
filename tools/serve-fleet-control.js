'use strict';

const http = require('node:http');
const {lstat, readFile} = require('node:fs/promises');
const path = require('node:path');
const {createFleetTracker} = require('../src/fleet-tracker');

const PROJECT_API = '/mission-control/analytics/api/projects';
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_SNAPSHOT_BYTES = 524288;

function readExport(snapshotRoot) {
  const root = path.resolve(snapshotRoot, 'api', 'projects');
  return async project => {
    if (!ID.test(project.project_id)) return null;
    try {
      const filename = path.join(root, project.project_id + '.json');
      const info = await lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SNAPSHOT_BYTES) return null;
      const payload = await readFile(filename);
      if (payload.length > MAX_SNAPSHOT_BYTES) return null;
      const data = JSON.parse(payload);
      if (data.project?.project_id !== project.project_id || data.project.repository !== project.repository ||
          data.project.branch !== project.branch) return null;
      // The exporter is the sole writer of this read-only mount. Its published
      // counts are deliberately ignored here; this service queries GitHub.
      return {local_progress: data.local_progress, codex_activity: data.codex_activity};
    } catch { return null; }
  };
}

function createFleetControlServer({snapshotRoot, tracker = createFleetTracker({
  observationReader: readExport(snapshotRoot),
})} = {}) {
  return http.createServer(async (req, res) => {
    function json(status, body) {
      res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
      res.end(JSON.stringify(body));
    }
    try {
      const {pathname, searchParams} = new URL(req.url, 'http://fleet-control.internal');
      if (pathname !== PROJECT_API && !(pathname.startsWith(PROJECT_API + '/') &&
          ID.test(pathname.slice(PROJECT_API.length + 1)))) return json(404, {error: 'Not found'});
      return await tracker.handle(req, res, {pathname, searchParams, json});
    } catch {
      return json(502, {error: 'Fleet Control observation unavailable'});
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.FLEET_CONTROL_PORT || 8081);
  const host = process.env.FLEET_CONTROL_ADDRESS || '127.0.0.1';
  const snapshotRoot = process.env.FLEET_CONTROL_SNAPSHOT_ROOT;
  if (!snapshotRoot || !path.isAbsolute(snapshotRoot) || !Number.isInteger(port) || port < 1 || port > 65535 ||
      !['127.0.0.1', '0.0.0.0'].includes(host)) throw Error('Invalid Fleet Control service configuration');
  createFleetControlServer({snapshotRoot}).listen(port, host, () => {
    process.stdout.write('Fleet Control project API ready\n');
  });
}

module.exports = {createFleetControlServer, readExport};
