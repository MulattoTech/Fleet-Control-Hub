'use strict';
const path = require('node:path');

// Live AO identity is distinct from archived pre-migration restore snapshots.
// One binding is shared by the native controller and the web Fleet Hub.
const BINDING = Object.freeze({
  id: 'mjobs',
  path: 'C:\\Tools\\Dev\\MJobs',
  repository: 'https://github.com/mulattotech/mjobs',
  legacyRestoreId: 'mjobs-luna',
  primaryModel: 'gpt-6-astra'
});
function matchesProject(project) {
  if (!project || project.id !== BINDING.id || project.kind !== 'single_repo') return false;
  const repo = String(project.repo || '').replace(/\.git$/i, '')
    .replace(/^git@github\.com:/i, 'https://github.com/').toLowerCase();
  return repo === BINDING.repository &&
    typeof project.path === 'string' &&
    path.win32.normalize(project.path).toLowerCase() === path.win32.normalize(BINDING.path).toLowerCase();
}
module.exports = { BINDING, matchesProject };
