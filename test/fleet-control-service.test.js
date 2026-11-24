'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {mkdtemp, mkdir, writeFile, rm} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const path = require('node:path');
const {createFleetTracker} = require('../src/fleet-tracker');
const {createFleetControlServer, readExport} = require('../tools/serve-fleet-control');

test('internal Fleet Control API joins a live GitHub reader with project-bound local exports', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'fleet-control-service-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  const directory = path.join(root, 'api', 'projects');
  await mkdir(directory, {recursive:true});
  const project = {project_id:'mjobs', repository:'MulattoTech/MJobs', branch:'main'};
  const local = {status:'CURRENT', original:{pass:186}};
  await writeFile(path.join(directory, 'mjobs.json'), JSON.stringify({
    project, local_progress:local, codex_activity:{status:'fresh',counts:{session_count:0}},
    published_acceptance:{status:'CURRENT',original:{pass:999}},
  }));
  await writeFile(path.join(directory, 'babytracker.json'), JSON.stringify({project, local_progress:local}));
  const reads = [];
  const tracker = createFleetTracker({
    repositoryProgress:{read:async repository => ({repository,status:'UNAVAILABLE',reason:'NO_GOALS'})},
    observationReader:readExport(root),
    acceptance:{read:async (id,{refresh}) => {
      reads.push({id,refresh});
      return {status:refresh?'STALE':'CURRENT', original:{pass:190}};
    }},
  });
  const server = createFleetControlServer({tracker});
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const base = origin + '/mission-control/analytics/api/projects';
  const normal = await (await fetch(base+'/mjobs')).json();
  assert.deepEqual(normal.local_progress,local);
  assert.equal(normal.published_acceptance.original.pass,190);
  assert.equal(normal.codex_activity.counts.session_count,0);
  assert.equal(normal.sync_requested,undefined);
  const force = await (await fetch(base+'/mjobs?refresh=1')).json();
  assert.equal(force.sync_requested,true);
  assert.equal(force.published_acceptance.status,'STALE');
  const other = await (await fetch(base+'/babytracker?refresh=1')).json();
  assert.equal(other.sync_requested,false);
  assert.equal(other.local_progress.status,'UNAVAILABLE');
  assert.equal((await fetch(base+'/mjobs?refresh=1',{method:'POST'})).status,405);
  assert.equal((await fetch(origin+'/api/session')).status,404);
  assert.deepEqual(reads,[{id:'mjobs',refresh:false},{id:'mjobs',refresh:true}]);
  const repositoryEndpoint = origin + '/mission-control/analytics/api/repository-progress?repository=owner/repo';
  assert.equal((await (await fetch(repositoryEndpoint)).json()).status,'UNAVAILABLE');
  assert.equal((await fetch(repositoryEndpoint,{method:'POST'})).status,405);
});
