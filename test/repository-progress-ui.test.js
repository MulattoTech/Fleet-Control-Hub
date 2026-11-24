'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const root=path.resolve(__dirname,'../packages/mjobs-controller/remote/public/analytics');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const script=fs.readFileSync(path.join(root,'atlas.js'),'utf8');
const sourceFunction=name=>{
  const match=script.match(new RegExp(`^ function ${name}\\([^\\n]+$`,'m'));
  assert.ok(match,`source function ${name} is present as a self-contained helper`);
  return vm.runInNewContext(`(${match[0].trim()})`,{URL});
};

test('repository normalization canonicalizes case and rejects ambiguous URL paths',()=>{
  const normalize=sourceFunction('normalizeRepository');
  assert.equal(normalize('MulattoTech/MJobs'),'mulattotech/mjobs');
  assert.equal(normalize('https://github.com/MulattoTech/MJobs.git/'),'mulattotech/mjobs');
  for(const rejected of [
    'https://github.com:443/owner/repo',
    'https://github.com/owner/../repo',
    'https://github.com/owner/%2e%2e/repo',
    'https://github.com/owner%2frepo',
    'owner\\repo',
    'https://github.com/owner\\repo',
    'https://github.com/owner/repo?tab=readme',
    'http://github.com/owner/repo'
  ]) assert.equal(normalize(rejected),null,rejected);
});

test('repository estimates lose ESTIMATED status after five minutes or missing check time',()=>{
  const classify=sourceFunction('classifyEstimateStatus');
  const counts=sourceFunction('estimateCounts');
  const now=Date.parse('2026-11-23T18:00:00Z');
  assert.equal(classify({status:'ESTIMATED',checked_at:'2026-11-23T17:56:00Z'},now),'ESTIMATED');
  assert.equal(classify({status:'ESTIMATED',checked_at:'2026-11-23T17:54:59Z'},now),'STALE');
  assert.equal(classify({status:'ESTIMATED'},now),'STALE');
  assert.equal(classify({status:'STALE',checked_at:'2026-11-23T17:59:59Z'},now),'STALE');
  assert.equal(classify({status:'UNAVAILABLE',checked_at:'2026-11-23T17:59:59Z'},now),'UNAVAILABLE');
  const cached={total:8,done:4,in_progress:1,not_started:2,blocked:1,percent:50};
  assert.deepEqual(JSON.parse(JSON.stringify(counts(cached,'STALE'))),[['Total',8],['Done',4],['In progress',1],['Not started',2],['Blocked',1],['Goal estimate','50%']]);
  assert.deepEqual(JSON.parse(JSON.stringify(counts(cached,'UNAVAILABLE'))),[]);
});

test('custom project options stay capped at twenty bookmarks plus the active direct link',()=>{
  const lines=script.split('\n');
  const helpers=['appendCustomOptions','syncCustomOptions','updateProjectStatus'].map(name=>{
    const line=lines.find(value=>value.startsWith(` function ${name}(`));
    assert.ok(line,`source helper ${name} exists`);return line.trim();
  });
  const select={value:'repo:active/direct',options:[
    {value:'mjobs',remove(){select.options=select.options.filter(option=>option!==this);}},
    {value:'repo:old/unbookmarked',remove(){select.options=select.options.filter(option=>option!==this);}},
    {value:'repo:active/direct',remove(){select.options=select.options.filter(option=>option!==this);}}
  ],append(option){this.options.push(option);}};
  const updates=[];
  const context={
    customRepositories:Array.from({length:20},(_,i)=>`owner/repo-${i}`),
    trackedProjects:[{project_id:'mjobs'},{project_id:'baby'}],
    document:{createElement:()=>({})},
    $(id){assert.equal(id,'project-select');return select;},
    set(id,value){updates.push([id,value]);}
  };
  vm.runInNewContext(`${helpers.join('\n')}\nglobalThis.sync=syncCustomOptions;`,context);
  context.sync();
  const custom=select.options.filter(option=>option.value.startsWith('repo:'));
  assert.equal(custom.length,21);
  assert.ok(custom.some(option=>option.value==='repo:active/direct'));
  assert.ok(!custom.some(option=>option.value==='repo:old/unbookmarked'));
  assert.deepEqual(updates.at(-1),['project-status','2 tracked projects · 20 public repo bookmarks']);
});

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
  assert.ok(script.includes("classifyEstimateStatus(result)"));
  assert.ok(script.includes('refreshRepositoryFreshness()'));
  assert.ok(script.includes("if(result?.reason)fields.push(['Reason',result.reason])"));
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
