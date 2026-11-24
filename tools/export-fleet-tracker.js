'use strict';

const {randomBytes} = require('node:crypto');
const {lstat, mkdir, rename, unlink, writeFile} = require('node:fs/promises');
const path = require('node:path');
const {parseArgs} = require('node:util');
const {setTimeout: delay} = require('node:timers/promises');
const {createFleetTracker} = require('../src/fleet-tracker');
const {createMissionStatus} = require('../src/mission-status');

const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

async function existingDirectory(directory) {
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Export destination must be a real directory');
}

async function subdirectory(parent, name) {
  const dir = path.join(parent, name);
  try { await mkdir(dir); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  await existingDirectory(dir);
  return dir;
}

async function writeJson(directory, name, value) {
  const file = path.join(directory, name);
  try {
    const entry = await lstat(file);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Export file is redirected');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = path.join(directory, `.${name}.${randomBytes(8).toString('hex')}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value)}\n`, {flag: 'wx', mode: 0o644});
  try { await rename(temporary, file); }
  finally { try { await unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}

async function exportFleetTracker(tracker, outputDir) {
  const root = path.resolve(outputDir);
  await existingDirectory(root);
  const api = await subdirectory(root, 'api');
  const projectsDir = await subdirectory(api, 'projects');
  const catalog = tracker.listProjects();
  const projectIds = catalog.projects.map(project => project.project_id);
  if (projectIds.some(id => !PROJECT_ID.test(id) || id === 'index')) throw new Error('Invalid project export identifier');
  const reports = await Promise.all(projectIds.map(id => tracker.projectReport(id)));

  const activities = reports.map((report, index) => {
    const id = projectIds[index];
    if (report?.project?.project_id !== id) throw new Error('Project export scope changed');
    const activity = report.codex_activity;
    return activity?.project_id === id ? activity : {project_id: id, status: 'unavailable'};
  });
  for (const report of reports) await writeJson(projectsDir, `${report.project.project_id}.json`, report);
  const exported_at = new Date().toISOString();
  await writeJson(root, 'desktop-activity.json', {schema_version: 1, exported_at, projects: activities});
  await writeJson(projectsDir, 'index.json', catalog);
  return {exported_at, projects: projectIds.length};
}

async function main() {
  const {values} = parseArgs({options: {output: {type: 'string'}, watch: {type: 'boolean'}}});
  if (!values.output) throw new Error('Provide an existing export directory with --output');
  const tracker = createFleetTracker({mission: createMissionStatus()});
  do {
    const receipt = await exportFleetTracker(tracker, values.output);
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    if (values.watch) await delay(15000);
  } while (values.watch);
}

if (require.main === module) main().catch(error => {console.error(error.message); process.exitCode = 1;});
module.exports = {exportFleetTracker};
