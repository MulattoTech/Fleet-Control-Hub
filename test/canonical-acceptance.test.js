'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {readCanonicalProgress}=require('../src/canonical-acceptance');
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-acceptance-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const name of ['planning','docs'])fs.mkdirSync(path.join(root,name));
  const requirements=[
    {requirement_id:'MJ-REQ-001',result:'PASS',area:'core',priority:'P0'},
    {requirement_id:'MJ-REQ-002',result:'PARTIAL',area:'core',priority:'P1'},
    {requirement_id:'MJ-REQ-003',result:'NOT_RUN',area:'ui',priority:'P1'}
  ];
  const cap={schema_version:1,timestamp:'2026-11-03T05:59:31Z',requirements};
  const refs={schema_version:3,generated_at:'2026-10-09T15:07:39Z',canonical_ids:['MJ-REF-001','MJ-REF-002'],
    result_by_id:{'MJ-REF-001':{result:'PASS'},'MJ-REF-002':{result:'NOT_RUN'}}};
  const card={schema_version:1,original:{pass:1,partial:1,not_run:1,total:3,as_of:cap.timestamp},
    reference:{pass:1,partial:0,not_run:1,total:2,as_of:refs.generated_at},release_readiness:'UNKNOWN'};
  const write=(name,value)=>fs.writeFileSync(path.join(root,name),JSON.stringify(value));
  write('planning/CAPABILITY_MATRIX.json',cap);
  write('planning/REFERENCE_GAP_MATRIX.json',refs);
  write('docs/PROGRESS_CARD.json',card);
  return {root,cap,refs,card,write};
}
test('Hub reads canonical MJobs matrices directly, with truthful timestamps and no old dashboard',t=>{
  const f=fixture(t),sha='a'.repeat(40),git=(root,...args)=>args.includes('HEAD')?sha:args.includes('refs/heads/main')?sha:'main';
  const status=readCanonicalProgress({root:f.root,git});
  assert.equal(status.available,true);
  assert.deepEqual(status.original,{pass:1,partial:1,not_run:1,total:3});
  assert.deepEqual(status.reference,{pass:1,partial:0,not_run:1,total:2});
  assert.equal(status.original_as_of,f.cap.timestamp);
  assert.equal(status.reference_as_of,f.refs.generated_at);
  assert.equal(status.card_counts_match_matrices,true);
  assert.equal(status.checkpoint_current,false,'count match alone does not prove all dashboard artifacts current');
  assert.equal(status.git.github_main_sha,null,'no claimed network verification');
  assert.equal(status.git.checkout_head_sha,sha);
  assert.deepEqual(status.areas.find(x=>x.name==='core'),{name:'core',pass:1,partial:1,not_run:0,total:2});
  assert.deepEqual(status.priorities.find(x=>x.name==='P1'),{name:'P1',pass:0,partial:1,not_run:1,total:2});
});
test('stale acceptance card cannot override live matrix counts',t=>{
  const f=fixture(t);f.card.original.pass=2;f.write('docs/PROGRESS_CARD.json',f.card);
  const status=readCanonicalProgress({root:f.root,git:()=>null});
  assert.equal(status.original.pass,1);assert.equal(status.card_counts_match_matrices,false);
  assert.equal(status.release_readiness,'UNKNOWN');
});
test('malformed, duplicate, or noncanonical acceptance evidence fails closed',t=>{
  const f=fixture(t);
  f.cap.requirements[1].requirement_id='MJ-REQ-001';
  f.write('planning/CAPABILITY_MATRIX.json',f.cap);
  assert.throws(()=>readCanonicalProgress({root:f.root,git:()=>null}),/Duplicate/);
  f.cap.requirements[1].requirement_id='MJ-REQ-002';f.cap.requirements[0].result='APPROVED';
  f.write('planning/CAPABILITY_MATRIX.json',f.cap);
  assert.throws(()=>readCanonicalProgress({root:f.root,git:()=>null}),/Unexpected acceptance/);
  f.cap.requirements[0].result='PASS';f.write('planning/CAPABILITY_MATRIX.json',f.cap);
  f.refs.result_by_id['MJ-REF-002'].result='SKIP';f.write('planning/REFERENCE_GAP_MATRIX.json',f.refs);
  assert.throws(()=>readCanonicalProgress({root:f.root,git:()=>null}),/Unexpected acceptance/);
});
test('missing canonical evidence never silently falls back to an old dashboard',t=>{
  const f=fixture(t);fs.unlinkSync(path.join(f.root,'planning','CAPABILITY_MATRIX.json'));
  assert.throws(()=>readCanonicalProgress({root:f.root,git:()=>null}));
});
