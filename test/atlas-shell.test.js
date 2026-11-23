'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const analytics=path.resolve(__dirname,'../packages/mjobs-controller/remote/public/analytics');
const html=fs.readFileSync(path.join(analytics,'index.html'),'utf8');
const script=fs.readFileSync(path.join(analytics,'atlas.js'),'utf8');
const styles=fs.readFileSync(path.join(analytics,'atlas.css'),'utf8');

test('Fleet Tracker exposes linkable project views with one shared navigation',()=>{
  assert.match(html,/<title>Fleet Tracker/);
  assert.match(html,/aria-label="Fleet workspace"/);
  for(const view of ['overview','requirements','campaign-progress','codex-activity']){
    assert.match(html,new RegExp(`href="#${view}"`));
    assert.match(html,new RegExp(`id="${view}"`));
  }
  assert.match(html,/id="project-select"/);
  assert.match(html,/<button id="refresh"/);
  assert.equal(styles.includes('\\n'),false,'escaped line breaks cannot consume the theme root selector');
  assert.match(html,/id="grafana-link" href="\.\.\/grafana\/"/);
  assert.doesNotMatch(html,/<iframe/i);
});

test('project views load through same-origin APIs and keep browser navigation in sync',()=>{
  assert.match(script,/fetch\('\.\/api\/projects'/);
  assert.match(script,/\.\/api\/projects\//);
  assert.match(script,/history\.pushState/);
  assert.match(script,/popstate/);
  assert.match(script,/published_acceptance/);
  assert.match(script,/local_progress/);
  assert.match(script,/codex_activity/);
  assert.doesNotMatch(script,/127\.0\.0\.1:\d+/);
});
