'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'../packages/mjobs-controller/remote/public/analytics');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const script=fs.readFileSync(path.join(root,'atlas.js'),'utf8');

test('repository progress is a public-only, same-origin estimate with explicit provenance',()=>{
  assert.match(html,/id="repository-input"/);
  assert.match(html,/Public repositories only/);
  assert.match(html,/local storage/);
  assert.match(html,/repo-reported task completion/i);
  assert.match(script,/const url='\.\/api\/repository-progress\?repository='\+encodeURIComponent\(repo\)/);
  assert.match(script,/refresh\?'&refresh=1'/);
  for(const field of ['branch','commit','method','observed_at','checked_at','source_path','reason'])
    assert.ok(script.includes(`result?.${field}`),`missing ${field} provenance`);
  assert.match(script,/\['Goal estimate',typeof result\.percent==='number'/);
  assert.match(script,/status==='UNAVAILABLE'/);
  assert.match(script,/normalizeRepository\(result\?\.repository\)!==repo/);
});

test('repository bookmarks are capped, guarded, removable, and reuse tracked projects',()=>{
  assert.match(script,/fleetHub\.publicRepositories/);
  assert.match(script,/\.slice\(0,20\)/);
  assert.match(script,/catch\{return \[\];\}/);
  assert.match(script,/setItem\('fleetHub\.publicRepositories'/);
  assert.match(script,/Forget/);
  assert.match(script,/projectForRepository\(repo\)/);
  assert.match(script,/clearMjobsProject\(\)/);
  assert.match(script,/setCustomSurface\(true\)/);
  assert.match(script,/history\.pushState/);
  assert.match(script,/popstate/);
  assert.doesNotMatch(script,/https?:\/\/api\.github\.com/);
});
