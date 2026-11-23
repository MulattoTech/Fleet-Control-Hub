'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const dashboard=JSON.parse(fs.readFileSync(path.join(__dirname,'../packages/mjobs-controller/observability/dashboards/fleet-atlas.json'),'utf8'));
const panels=dashboard.panels;

test('the Grafana data origin admits the fixed Desktop observation file read-only',()=>{
  const config=fs.readFileSync(path.join(__dirname,'../packages/mjobs-controller/observability/data-nginx.conf'),'utf8');
  assert.match(config,/location = \/desktop-activity\.json \{ limit_except GET \{ deny all; \} add_header Cache-Control "no-store"; try_files \$uri =404; \}/);
  assert.match(config,/location \/ \{ return 404; \}/);
});

test('Grafana exposes project-scoped Codex Desktop status and provenance',()=>{
  const panel=panels.find(item=>item.title==='Codex Desktop activity · source status');
  assert.ok(panel);
  const query=panel.targets[0];
  assert.equal(query.url,'http://fleet-analytics-data:8080/desktop-activity.json');
  assert.equal(query.url_options.method,'GET');
  assert.match(query.root_selector,/schema_version = 1/);
  assert.match(query.root_selector,/exported_at/);
  assert.match(query.root_selector,/\$millis\(\)/);
  for(const field of ['project_id','source','status','observed_at','latest_activity_utc','age_seconds','max_age_seconds','coverage_partial'])
    assert.ok(query.columns.some(column=>column.selector===field),`missing ${field}`);
});

test('Grafana activity counts admit only fresh observations and retain literal zero values',()=>{
  const panel=panels.find(item=>item.title==='Codex Desktop activity · fresh project counts');
  assert.ok(panel);
  const query=panel.targets[0];
  assert.equal(query.url,'http://fleet-analytics-data:8080/desktop-activity.json');
  assert.equal(query.url_options.method,'GET');
  assert.match(query.root_selector,/schema_version = 1/);
  assert.match(query.root_selector,/exported_at/);
  assert.match(query.root_selector,/status = 'fresh'/);
  assert.match(query.root_selector,/observed_at/);
  assert.match(query.root_selector,/\$millis\(\)/);
  assert.match(query.root_selector,/max_age_seconds/);
  for(const field of ['project_id','source','observed_at','counts.session_count','counts.active_process_count','counts.workspace_count'])
    assert.ok(query.columns.some(column=>column.selector===field),`missing ${field}`);
  assert.match(panel.description,/expired or unavailable source leaves the count cells empty/);
  assert.match(query.root_selector,/\{'status':'stale_or_unavailable'\}/);
  assert.doesNotMatch(query.root_selector,/\|\|\s*0|\?:\s*0/);
});
