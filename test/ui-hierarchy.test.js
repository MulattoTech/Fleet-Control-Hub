'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const read=relative=>fs.readFileSync(path.join(root,relative),'utf8');

test('Fleet overview puts current development before formal acceptance',()=>{
  const html=read('public/index.html');
  const development=html.indexOf('id="development-delivery"');
  const acceptance=html.indexOf('id="mission-control"');
  const navDevelopment=html.indexOf('href="#development-delivery"');
  const navAcceptance=html.indexOf('href="#mission-control"');
  assert.ok(development>=0&&acceptance>=0&&development<acceptance);
  assert.ok(navDevelopment>=0&&navAcceptance>=0&&navDevelopment<navAcceptance);
  assert.match(html,/Current implementation, GitHub integration, and validation signals come first/);
  assert.match(html,/Formal acceptance &amp; release gate/);
  assert.match(html,/intentionally not a coding-throughput meter/);
});

test('Concurrent-turn control keeps slider changes preview-only until explicit Save',()=>{
  const html=read('packages/mjobs-controller/public/index.html');
  const script=read('packages/mjobs-controller/public/turbo-ui.js');
  assert.match(html,/id="tTargetRange" type="range"/);
  assert.match(html,/id="tTarget" class="turbo-target-number" type="number"/);
  assert.match(html,/Preview only until Save limits/);
  assert.match(html,/id="tTargetRoster">40 roster max/);
  assert.match(script,/el\('tTargetRoster'\)\.textContent=limit\+' roster max'/);
  assert.match(script,/settingsDirty\?'Draft ':'Configured '/);
  assert.match(script,/classList\.toggle\('draft',settingsDirty\)/);
  const handlerStart=script.indexOf("el('tTargetRange').addEventListener('input'");
  const handlerEnd=script.indexOf("el('tTarget').addEventListener('input'",handlerStart);
  assert.ok(handlerStart>=0&&handlerEnd>handlerStart);
  const rangeHandler=script.slice(handlerStart,handlerEnd);
  assert.match(rangeHandler,/settingsDirty=true/);
  assert.doesNotMatch(rangeHandler,/api\(/);
  assert.match(script,/el\('turboSave'\)\.addEventListener\('click',settings\)/);
});
