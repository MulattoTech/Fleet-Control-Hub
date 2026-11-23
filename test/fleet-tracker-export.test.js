'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {mkdtemp, readFile, readdir, rm} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {exportFleetTracker} = require('../tools/export-fleet-tracker');

test('export writes the catalog, exact project snapshots, and separate Grafana activity', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fleet-tracker-export-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  const project = {project_id:'mjobs', name:'MJobs'};
  const codex_activity = {project_id:'mjobs', status:'fresh', counts:{session_count:0}};
  const tracker = {listProjects:() => ({default_project_id:'mjobs', projects:[project]}),
    projectReport:async () => ({project, codex_activity, checked_by_fixture:true})};
  const receipt = await exportFleetTracker(tracker, directory);
  assert.equal(receipt.projects, 1);
  assert.deepEqual(await readdir(directory), ['api', 'desktop-activity.json']);
  const read = async (...parts) => JSON.parse(await readFile(join(directory, ...parts), 'utf8'));
  assert.equal((await read('api','projects','index.json')).default_project_id,'mjobs');
  assert.equal((await read('api','projects','mjobs.json')).checked_by_fixture,true);
  assert.deepEqual(await read('desktop-activity.json'), {
    schema_version:1, exported_at:receipt.exported_at, projects:[codex_activity],
  });
  await exportFleetTracker(tracker, directory);
  assert.deepEqual(await readdir(join(directory,'api','projects')), ['index.json','mjobs.json']);
});

test('export rejects foreign project results and unsafe filenames', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fleet-tracker-rejected-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  for (const bad of ['../foreign','index']) {
    await assert.rejects(exportFleetTracker({listProjects:() => ({projects:[{project_id:bad}]})},
      directory), /Invalid project export identifier/);
  }
  await assert.rejects(exportFleetTracker({listProjects:() => ({projects:[{project_id:'mjobs'}]}),
    projectReport:async () => ({project:{project_id:'foreign'}})}, directory), /Project export scope changed/);
});
