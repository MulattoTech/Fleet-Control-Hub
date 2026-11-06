'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const pkg=path.resolve(__dirname,'../packages/mjobs-controller');

test('legacy Mission route is strictly localhost and fixed-target',()=>{
 const source=fs.readFileSync(path.join(pkg,'Mission-Control-18726-Redirect.js'),'utf8');
 assert.match(source,/const host='127\.0\.0\.1', port=18726/);
 assert.match(source,/const destination='http:\/\/127\.0\.0\.1:18729'/);
 assert.match(source,/server\.listen\(port,host/);
 assert.match(source,/res\.writeHead\(307/);
 assert.doesNotMatch(source,/0\.0\.0\.0/);
});

test('Grafana source dashboard contains no stale machine-specific agent list',()=>{
 const d=JSON.parse(fs.readFileSync(path.join(pkg,'observability/dashboards/fleet-atlas.json'),'utf8'));
 const variables=d.templating.list.filter(v=>v.name==='agent');
 assert.equal(variables.length,1);
 assert.equal(variables[0].type,'custom');
 assert.equal(variables[0].current.value,'mjobs-1');
 assert.equal(variables[0].query,'mjobs-1');
 assert.deepEqual(variables[0].options.map(v=>v.value),['mjobs-1']);
});

test('Grafana agent refresher fails closed on stale source and only updates options atomically',()=>{
 const source=fs.readFileSync(path.join(pkg,'Sync-MJobs-Grafana-Agents.py'),'utf8');
 assert.match(source,/status\.get\('available'\) is not True/);
 assert.match(source,/status\.get\('reasonCode'\)!='OK'/);
 assert.match(source,/age\(status\.get\('checkedAt'\)\)>90/);
 assert.match(source,/mjobs-\[0-9\]\+/);
 assert.match(source,/dash\.is_symlink\(\)/);
 assert.match(source,/os\.replace\(temp,dash\)/);
});
