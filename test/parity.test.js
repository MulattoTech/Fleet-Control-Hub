'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createParityTracker,catalogProjection,checkSummary,parseGitHubResponse}=require('../src/parity');
const A='a'.repeat(40),B='b'.repeat(40),C='c'.repeat(40);
const SECRET='private-candidate-secret@example.invalid';
const check=(id=1,conclusion='success',status='completed',name='CI',app=15368)=>({id,app:{id:app},name,status,conclusion});
function catalog(){return {schema_version:1,initiative_id:'MJ-TH',repository:'MulattoTech/MJobs',epic_issue:904,as_of:'2026-11-03T05:00:00Z',
  audit:{coverage:{routes_identified:3,routes_exercised:0,journeys_identified:2,journeys_exercised:0},har:{status:'BLOCKED'},blockers:['FULL_HAR_TOOL_UNAVAILABLE']},
  project:{sync_status:'BLOCKED_AUTH_SCOPE'},workstreams:[{key:'MJ-TH-RECON',issue:903}],
  features:[{id:'MJ-TH-001',title:'Remote discovery',discovery_state:'PUBLICLY CLAIMED',implementation_state:'ALREADY EXISTS',priority:'P1',issues:[26],requirements:['MJ-REQ-025'],dependencies:[],verification:{status:'NOT_RUN'}},
    {id:'MJ-TH-002',title:'Resume enhancement',discovery_state:'INACCESSIBLE / AUTHORIZATION REQUIRED',implementation_state:'PARTIAL',priority:'P1',issues:[96],requirements:['MJ-REQ-095'],dependencies:['MJ-TH-001'],verification:{status:'NOT_RUN'}}]};}
function fixture(){
  let clock=Date.parse('2026-11-03T06:00:00Z'),bad=false;const calls=[];let document=catalog();
  const read=async(path,signal)=>{
    calls.push(path);assert.ok(signal);if(bad)throw Error(SECRET);
    const route=path.replace('repos/MulattoTech/MJobs/','');
    if(route==='git/ref/heads/main')return {object:{sha:A}};
    if(route==='contents/docs/talenthop/catalog.json?ref='+A)return {encoding:'base64',content:Buffer.from(JSON.stringify(document)).toString('base64')};
    if(/^issues\/\d+$/.test(route))return {number:Number(route.slice(7)),state:'closed',updated_at:'2026-11-03T05:30:00Z',body:SECRET,user:{email:SECRET}};
    if(route==='pulls?state=open&per_page=100&page=1')return [{number:906,state:'open',head:{sha:B},body:'Refs #96\n'+SECRET,title:SECRET,draft:false}];
    if(route==='pulls?state=closed&sort=updated&direction=desc&per_page=100&page=1')return [
      {number:907,state:'closed',merged_at:'2026-11-03T05:35:44Z',merge_commit_sha:B,
        base:{ref:'main',repo:{full_name:'MulattoTech/MJobs'}},body:'MJ-TH-002 #96\n'+SECRET,title:SECRET},
      {number:904,state:'closed',merged_at:null,body:'MJ-TH-001 #26',base:{ref:'main',repo:{full_name:'MulattoTech/MJobs'}}}
    ];
    if(route==='commits/'+B+'/check-runs?per_page=100')return {total_count:1,check_runs:[{...check(),output:{text:SECRET}}]};
    if(route==='git/matching-refs/heads/webpro-claims/')return [{ref:'refs/heads/webpro-claims/MJ-TH-RECON',object:{sha:C}}];
    if(route==='git/commits/'+C)return {sha:C,message:'Owner webpro-20261103T050255Z-1ba724 '+SECRET,committer:{date:'2026-11-03T05:00:00Z',email:SECRET}};
    throw Error('Unexpected fixture route');
  };
  return {calls,read,now:()=>clock,advance:ms=>{clock+=ms;},fail:value=>{bad=value;},setCatalog:value=>{document=value;}};
}
test('live metadata is projected without bodies, identities or inferred delivery acceptance',async()=>{
  const f=fixture(),tracker=createParityTracker(f);const result=await tracker.status();
  assert.equal(result.available,true);assert.equal(result.stale,false);assert.equal(result.sourceSha,A);
  assert.equal(result.features[1].issues[0].state,'closed');assert.equal(result.features[1].pulls[0].ci.state,'PASS');
  assert.deepEqual(result.features[1].relatedMerges,[{number:907,mergeSha:B,mergedAt:'2026-11-03T05:35:44Z',url:'https://github.com/MulattoTech/MJobs/pull/907'}]);
  assert.deepEqual(result.features[0].relatedMerges,[]);assert.deepEqual(result.mergeWindow,{examined:2,complete:true,order:'RECENTLY_UPDATED_CLOSED_PRS'});
  assert.equal(result.features[1].delivery.state,'NOT_VERIFIED');assert.equal(result.features[1].delivery.mergeSha,null);
  assert.equal(result.features[1].delivery.accepted,null);assert.equal(result.features[1].delivery.deployedSha,null);
  assert.equal(result.workstreams[0].claims[0].runId,'webpro-20261103T050255Z-1ba724');
  assert.equal(result.workstreams[0].claims[0].ageIndicator,'OLDER_THAN_30_MINUTES');
  assert.equal(result.workstreams[0].claims[0].heartbeat,null);
  assert.equal(result.discoveryCounts.OBSERVED,0);assert.equal(result.coverage.routes.exercised,0);
  assert.equal(result.projectSync,'BLOCKED_AUTH_SCOPE');assert.equal(result.harStatus,'BLOCKED');
  assert.ok(!JSON.stringify(result).includes(SECRET));
  assert.ok(f.calls.every(path=>path.startsWith('repos/MulattoTech/MJobs/')));
});
test('bounded closed PR window never invents complete history or feature acceptance',async()=>{
  const f=fixture(),route='pulls?state=closed&sort=updated&direction=desc&per_page=100&page=1';
  const read=(path,signal)=>path.endsWith(route)?Array.from({length:100},(_,i)=>({number:i+1,state:'closed',merged_at:null})):f.read(path,signal);
  const result=await createParityTracker({...f,read}).status();
  assert.equal(result.available,true);assert.equal(result.mergeWindow.complete,false);assert.equal(result.mergeWindow.examined,100);
  assert.equal(result.features[1].relatedMerges.length,0);assert.equal(result.features[1].delivery.state,'NOT_VERIFIED');
  assert.ok(result.warnings.includes('CLOSED_PR_HISTORY_WINDOW_INCOMPLETE'));
});
test('linked merged PR evidence is scoped to main and invalid receipts fail closed',async()=>{
  const f=fixture(),route='pulls?state=closed&sort=updated&direction=desc&per_page=100&page=1';
  const base={number:912,state:'closed',merged_at:'2026-11-03T05:40:00Z',merge_commit_sha:B,
    base:{ref:'main',repo:{full_name:'MulattoTech/MJobs'}},body:'MJ-TH-002'};
  for(const row of [{...base,merge_commit_sha:'invalid'},{...base,merged_at:'not-a-date'},{...base,state:'open'}]){
    const read=(path,signal)=>path.endsWith(route)?[row]:f.read(path,signal);
    const result=await createParityTracker({...f,read}).status();
    assert.equal(result.available,false);assert.equal(result.stale,true);
  }
  for(const row of [{...base,base:{ref:'release',repo:{full_name:'MulattoTech/MJobs'}}},
    {...base,base:{ref:'main',repo:{full_name:'someone/else'}}}]){
    const read=(path,signal)=>path.endsWith(route)?[row]:f.read(path,signal);
    const result=await createParityTracker({...f,read}).status();
    assert.equal(result.available,true);assert.deepEqual(result.features[1].relatedMerges,[]);
  }
});
test('concurrent reads coalesce and manual refresh respects the minimum interval',async()=>{
  const f=fixture(),tracker=createParityTracker(f);const results=await Promise.all([tracker.status(),tracker.status({refresh:true}),tracker.status()]);
  assert.deepEqual(results[0],results[1]);assert.equal(f.calls.filter(p=>p.endsWith('/git/ref/heads/main')).length,1);
  const count=f.calls.length;await tracker.status({refresh:true});assert.equal(f.calls.length,count);
  f.advance(60001);await tracker.status({refresh:true});assert.equal(f.calls.filter(p=>p.endsWith('/git/ref/heads/main')).length,2);
});
test('failure retains a visibly stale last good snapshot and backoff prevents a retry storm',async()=>{
  const f=fixture(),tracker=createParityTracker(f);const first=await tracker.status();f.advance(60001);f.fail(true);
  const failed=await tracker.status({refresh:true});assert.equal(failed.stale,true);assert.equal(failed.syncedAt,first.syncedAt);
  assert.equal(failed.error,'GITHUB_EVIDENCE_UNAVAILABLE');assert.ok(!JSON.stringify(failed).includes(SECRET));
  const count=f.calls.length;await tracker.status({refresh:true});assert.equal(f.calls.length,count);
  f.advance(60001);f.fail(false);const recovered=await tracker.status({refresh:true});assert.equal(recovered.stale,false);assert.notEqual(recovered.syncedAt,first.syncedAt);
});
test('a missing main catalog reports unavailable rather than an empty successful board',async()=>{
  const f=fixture();f.setCatalog({});const result=await createParityTracker(f).status();
  assert.equal(result.available,false);assert.equal(result.stale,true);assert.deepEqual(result.features,[]);
});
test('pagination exhaustion fails closed without silently dropping competing PRs',async()=>{
  const f=fixture();const read=async(path,signal)=>path.includes('/pulls?')?Array.from({length:100},(_,i)=>({number:i+1})):f.read(path,signal);
  const result=await createParityTracker({...f,read}).status();assert.equal(result.available,false);
});
test('catalog dimensions and feature IDs are validated before reading arbitrary issue numbers',async()=>{
  for(const mutate of [d=>{d.features[0].title=SECRET;},d=>{d.features[1].id=d.features[0].id;},d=>{d.audit.coverage.routes_exercised=99;},d=>{d.features[0].issues=['1;send-secret'];},d=>{d.features[0].dependencies=['MJ-TH-999'];}]){
    const data=catalog();mutate(data);assert.throws(()=>catalogProjection(data),/EVIDENCE_UNAVAILABLE/);
  }
});
test('unrecognized catalog content is not sent to the browser',()=>{
  const data=catalog();data.cookies=SECRET;data.features[0].private_evidence=SECRET;
  assert.ok(!JSON.stringify(catalogProjection(data)).includes(SECRET));
});
test('exact head checks distinguish pending, failed, missing, skipped and incomplete inventories',()=>{
  assert.equal(checkSummary({total_count:0,check_runs:[]}).state,'UNKNOWN');
  assert.equal(checkSummary({total_count:2,check_runs:[check()]}).state,'UNKNOWN');
  assert.equal(checkSummary({total_count:1,check_runs:[check(1,'skipped')]}).state,'UNKNOWN');
  assert.equal(checkSummary({total_count:1,check_runs:[check(1,null,'in_progress')]}).state,'PENDING');
  assert.equal(checkSummary({total_count:1,check_runs:[check(1,'failure')]}).state,'FAIL');
});
test('superseded failures and cancellations do not mask the latest successful context',()=>{
  const checks=[check(9,'failure'),check(12),check(10,'cancelled')];
  assert.deepEqual(checkSummary({total_count:3,check_runs:checks}),{state:'PASS',total:1,observedTotal:3,superseded:2});
  assert.deepEqual(checkSummary({total_count:3,check_runs:[...checks].reverse()}),{state:'PASS',total:1,observedTotal:3,superseded:2});
});
test('a newer pending or failed context supersedes prior success',()=>{
  for(const [latest,state] of [[check(2,null,'queued'),'PENDING'],[check(2,'failure'),'FAIL'],[check(2,'cancelled'),'FAIL'],[check(2,'skipped'),'UNKNOWN']]){
    assert.deepEqual(checkSummary({total_count:2,check_runs:[latest,check(1)]}),{state,total:1,observedTotal:2,superseded:1});
  }
});
test('different app identities and names cannot suppress each other',()=>{
  for(const different of [check(2,'success','completed','CI',999),check(2,'success','completed','Other CI')]){
    assert.deepEqual(checkSummary({total_count:2,check_runs:[check(1,'failure'),different]}),{state:'FAIL',total:2,observedTotal:2,superseded:0});
  }
});
test('missing or ambiguous check identities fail closed',()=>{
  for(const invalid of [{status:'completed',conclusion:'success'},{...check(),id:0},{...check(),app:null},{...check(),name:''},{...check(),status:'invented'}]){
    assert.deepEqual(checkSummary({total_count:1,check_runs:[invalid]}),{state:'UNKNOWN',total:null});
  }
  assert.deepEqual(checkSummary({total_count:2,check_runs:[check(1),check(1,'failure')]}),{state:'UNKNOWN',total:null});
});
test('a total deadline settles even when an injected transport never responds',async()=>{
  let signal;const tracker=createParityTracker({read:async(_path,current)=>{signal=current;return new Promise(()=>{});},deadlineMs:15});
  const result=await tracker.status();assert.equal(result.available,false);assert.equal(signal.aborted,true);
});
test('claim owner SHA mismatch invalidates the refresh and never grants ownership',async()=>{
  const f=fixture();const read=async(path,signal)=>path.endsWith('/git/commits/'+C)?{sha:A,committer:{date:'2026-11-03T05:00:00Z'}}:f.read(path,signal);
  const result=await createParityTracker({...f,read}).status();assert.equal(result.available,false);
});
test('restart starts unknown and performs a fresh canonical read instead of trusting a prior process',async()=>{
  const f=fixture();await createParityTracker(f).status();f.fail(true);const result=await createParityTracker(f).status();
  assert.equal(result.available,false);assert.equal(result.stale,true);
});
test('CI inspection failure stays unknown without hiding otherwise available issues',async()=>{
  const f=fixture();const read=async(path,signal)=>{if(path.includes('/check-runs?'))throw Error(SECRET);return f.read(path,signal);};
  const result=await createParityTracker({...f,read}).status();assert.equal(result.available,true);assert.equal(result.features[1].pulls[0].ci.state,'UNKNOWN');
});
test('response parsing honors Retry-After and rate-limit reset without exposing response secrets',()=>{
  assert.deepEqual(parseGitHubResponse('HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n{"ok":true}'),{ok:true});
  const clock=Date.parse('2026-11-03T06:00:00Z');
  for(const headers of ['Retry-After: 3600','Retry-After: Tue, 03 Nov 2026 07:00:00 GMT','X-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: '+(clock/1000+3600)]){
    try{parseGitHubResponse('HTTP/2.0 429 Rate limited\r\n'+headers+'\r\n\r\n'+SECRET,true,clock);assert.fail('must reject');}
    catch(error){assert.equal(error.retryAt,clock+3600000);assert.ok(!String(error).includes(SECRET));}
  }
});
test('server-directed cooldown wins over local retry backoff',async()=>{
  const f=fixture();let requests=0;const read=async()=>{requests++;const error=Error(SECRET);error.retryAt=f.now()+3600000;throw error;};
  const tracker=createParityTracker({...f,read});const first=await tracker.status();f.advance(600000);await tracker.status({refresh:true});
  assert.equal(requests,1);assert.equal(first.nextRefreshAt,'2026-11-03T07:00:00.000Z');
});
