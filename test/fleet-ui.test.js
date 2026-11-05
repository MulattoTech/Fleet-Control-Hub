'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {present}=require('../packages/fleet-ui/power-state');
const ready={name:'MJobs',online:true,known:true,phase:'paused',quota:{fresh:true,remainingPercent:80,minimumRemainingPercent:7,blocked:false}};
test('power action keeps its name across every state',()=>{for(const change of [{},{active:true},{running:true},{online:false},{known:false},{phase:'uncertain',pendingKind:'send'},{quota:{fresh:true,remainingPercent:7,minimumRemainingPercent:7,blocked:true}}])assert.equal(present({...ready,...change}).label,'Start MJobs');});
test('quota floor is visible, never a renamed action or a lower reserve',()=>{const r=present({...ready,quota:{fresh:true,remainingPercent:7,minimumRemainingPercent:7,blocked:true}});assert.equal(r.state,'held');assert.equal(r.canStart,false);assert.equal(r.reserve,7);assert.match(r.detail,/7% remaining \/ 7% reserve/);});
test('zero is zero; unavailable is not zero',()=>{assert.equal(present({...ready,quota:{fresh:true,remainingPercent:0,minimumRemainingPercent:7}}).remaining,0);for(const remainingPercent of [NaN,Infinity,'100',null,undefined,-1,101])assert.equal(present({...ready,quota:{fresh:true,remainingPercent,minimumRemainingPercent:7}}).remaining,null);});
test('unknown, stale, unsupported and pending sends cannot offer Start',()=>{for(const change of [{online:false},{known:false},{phase:'new-unknown'},{phase:'uncertain',pendingKind:'send'},{error:'Failed status read'},{quota:{fresh:false,remainingPercent:100,minimumRemainingPercent:7}},{quota:{fresh:true,remainingPercent:100}}])assert.equal(present({...ready,...change}).canStart,false);});
test('ready projects and preserved launch reconciliation are distinct from active work',()=>{assert.equal(present(ready).canStart,true);assert.equal(present({...ready,active:true}).state,'starting');assert.equal(present({...ready,running:true}).state,'running');assert.equal(present({...ready,phase:'uncertain',pendingKind:'spawn'}).canStart,true);});
test('failed Start is transparently retryable only when the native controller and quota permit it',()=>{
  const failed={...ready,phase:'blocked',lastFailure:'Outer MJobs checkout was not clean'};
  const retry=present(failed);assert.equal(retry.state,'retry');assert.equal(retry.canStart,true);assert.match(retry.detail,/checkout was not clean/);
  assert.equal(present({...failed,blockedReasons:['A pending native delivery must be reconciled']}).canStart,false);
  assert.equal(present({...failed,quota:{fresh:true,remainingPercent:7,minimumRemainingPercent:7,blocked:true}}).canStart,false);
});
test('a paused dispatch can resume even when the persisted phase still says running',()=>{
  const state=present({...ready,phase:'running',running:false});
  assert.equal(state.canStart,true);assert.match(state.status,/Paused/);
});
test('presentation works with a future project without granting a capability',()=>{const x=present({name:'Research Lab'});assert.equal(x.label,'Start Research Lab');assert.equal(x.canStart,false);assert.equal(present({...ready,name:'Research Lab'}).label,'Start Research Lab');});
test('canonical MJobs first screen contains ordinary Start and keeps advanced recovery separate',()=>{const html=fs.readFileSync(path.join(__dirname,'../packages/mjobs-controller/public/index.html'),'utf8');assert.match(html,/id="runSection"/);assert.match(html,/src="\/run-ui.js"/);assert.ok(html.indexOf('id="runSection"')<html.indexOf('id="quotaSection"'));assert.match(html,/Advanced: restore a saved fleet/);});
test('the remote monitor links to the existing protected Hub rather than submitting commands',()=>{const source=fs.readFileSync(path.join(__dirname,'../packages/mjobs-controller/remote/public/remote-controls.js'),'utf8');assert.match(source,/https:\/\/fleet.m-techlabs.com/);assert.doesNotMatch(source,/fetch\s*\(/);assert.match(source,/available:\(\)=>false/);});
test('remote monitor and Atlas expose a labelled Fleet Overview return link',()=>{
 for(const name of ['index.html','analytics/index.html']){
  const page=fs.readFileSync(path.join(__dirname,'../packages/mjobs-controller/remote/public',name),'utf8');
  assert.match(page,/<a id="fleet-overview" class="overview-home" href="https:\/\/fleet\.m-techlabs\.com\/">← Fleet Overview<\/a>/);
  assert.match(page,/aria-label="Fleet workspace"/);
 }
});
test('Atlas drawer, heatmap and generated theme share Flight Deck tokens',()=>{
 const css=fs.readFileSync(path.join(__dirname,'../packages/mjobs-controller/remote/public/analytics/atlas.css'),'utf8');
 const shared=fs.readFileSync(path.join(__dirname,'../packages/fleet-ui/atlas.css'),'utf8');
 assert.equal(css.split('/* BEGIN GENERATED FLEET UI */').length,2);
 assert.ok(css.includes(shared.trim()));
 assert.match(shared,/dialog,\.drawer-header\{background:var\(--fd-surface\)/);
 assert.match(shared,/\.level-4\{background:var\(--fd-accent\)/);
 const js=fs.readFileSync(path.join(__dirname,'../packages/mjobs-controller/remote/public/analytics/atlas.js'),'utf8');
 assert.match(js,/'grafana-link':'http:\/\/127\.0\.0\.1:18731\/mission-control\/grafana\/'/);
 assert.match(js,/30000/); // Keep queries aligned with the existing collector.
});
