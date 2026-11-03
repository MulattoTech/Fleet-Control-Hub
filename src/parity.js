'use strict';
// Read-only GitHub evidence. No native controller or agent APIs are imported.
const {execFile}=require('node:child_process');
const REPO='MulattoTech/MJobs', PREFIX='repos/'+REPO+'/';
const DISCOVERY=['OBSERVED','PUBLICLY CLAIMED','INACCESSIBLE / AUTHORIZATION REQUIRED','NOT FOUND / UNKNOWN'];
const IMPLEMENTATION=['ALREADY EXISTS','PARTIAL','MISSING','BLOCKED','VERIFIED IN TEST','MERGED','DEPLOYED','ACCEPTED'];
const BLOCKERS=['PRIVATE_SITE_AUTHORIZATION_REQUIRED','FULL_HAR_TOOL_UNAVAILABLE','PROJECT_AUTH_SCOPE_MISSING','INTERACTIVE_COVERAGE_NOT_RUN'];
const SHA=/^[a-f0-9]{40}$/;
const positive=n=>Number.isSafeInteger(n)&&n>0;
const date=s=>typeof s==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(s)&&Number.isFinite(Date.parse(s))?s:null;
const fail=()=>{throw Error('PARITY_EVIDENCE_UNAVAILABLE');};
function parseGitHubResponse(stdout,failed=false,clock=Date.now()){
  const match=typeof stdout==='string'?stdout.match(/^HTTP\/[\d.]+\s+(\d+)[^\r\n]*\r?\n([\s\S]*?)\r?\n\r?\n([\s\S]*)$/):null;
  const error=Error('PARITY_GITHUB_UNAVAILABLE');
  if(!match)throw error;
  const status=Number(match[1]),headers={};
  for(const line of match[2].split(/\r?\n/)){const colon=line.indexOf(':');if(colon>0)headers[line.slice(0,colon).toLowerCase()]=line.slice(colon+1).trim();}
  if(status===403||status===429){
    const retry=headers['retry-after'],numeric=/^\d{1,9}$/.test(retry||'')?clock+Number(retry)*1000:Date.parse(retry||'');
    const reset=headers['x-ratelimit-remaining']==='0'&&/^\d{1,12}$/.test(headers['x-ratelimit-reset']||'')?Number(headers['x-ratelimit-reset'])*1000:0;
    const candidate=Math.max(Number.isFinite(numeric)?numeric:0,reset);
    if(candidate>clock&&candidate<8_640_000_000_000_000)error.retryAt=candidate;
  }
  if(failed||status!==200)throw error;
  try{return JSON.parse(match[3]);}catch{throw Error('PARITY_GITHUB_INVALID');}
}
function githubRead(apiPath,signal){
  if(!apiPath.startsWith(PREFIX)||apiPath.length>500)return Promise.reject(Error('PARITY_PATH_REFUSED'));
  return new Promise((resolve,reject)=>execFile('gh',['api','--include','--hostname','github.com',apiPath],
    {timeout:10000,maxBuffer:2_000_000,windowsHide:true,signal},(error,stdout)=>{
      try{resolve(parseGitHubResponse(stdout,!!error));}catch(safeError){reject(safeError);}
    }));
}
async function mapBounded(items,fn){
  const result=new Array(items.length);let cursor=0;
  await Promise.all(Array.from({length:Math.min(4,items.length)},async()=>{
    while(cursor<items.length){const index=cursor++;result[index]=await fn(items[index]);}
  }));
  return result;
}
function catalogProjection(raw){
  if(raw?.schema_version!==1||raw?.initiative_id!=='MJ-TH'||raw?.repository!==REPO||!positive(raw.epic_issue)||
     !Array.isArray(raw.features)||raw.features.length<1||raw.features.length>100||!date(raw.as_of))fail();
  const ids=new Set(),features=[];
  for(const f of raw.features){
    if(!/^MJ-TH-\d{3}$/.test(f?.id)||ids.has(f.id)||typeof f.title!=='string'||f.title.length>100||
       !/^[A-Za-z0-9][A-Za-z0-9 ,/().&-]*$/.test(f.title)||!DISCOVERY.includes(f.discovery_state)||
       !IMPLEMENTATION.includes(f.implementation_state)||!/^P[0-6]$/.test(f.priority)||
       !Array.isArray(f.issues)||!f.issues.length||f.issues.length>12||f.issues.some(n=>!positive(n))||
       !Array.isArray(f.requirements)||f.requirements.length>12||f.requirements.some(n=>!/^MJ-REQ-\d{3}(?:\.[A-Z]\d{2})?$/.test(n))||
       !Array.isArray(f.dependencies)||f.dependencies.length>100)fail();
    ids.add(f.id);
    features.push({id:f.id,title:f.title,discovery:f.discovery_state,implementation:f.implementation_state,
      priority:f.priority,issueNumbers:[...new Set(f.issues)],requirements:[...f.requirements],dependencies:[...f.dependencies]});
  }
  if(features.some(f=>f.dependencies.some(id=>!ids.has(id))))fail();
  const coverage={};
  for(const type of ['routes','journeys']){
    const known=raw.audit?.coverage?.[type+'_identified'],done=raw.audit?.coverage?.[type+'_exercised'];
    if(!Number.isSafeInteger(known)||known<0||known>10000||!Number.isSafeInteger(done)||done<0||done>known)fail();
    coverage[type]={identified:known,exercised:done};
  }
  if(!['FULL','PARTIAL','BLOCKED','NOT_RUN'].includes(raw.audit?.har?.status)||!Array.isArray(raw.audit?.blockers)||
     raw.audit.blockers.some(code=>!BLOCKERS.includes(code))||!Array.isArray(raw.workstreams)||raw.workstreams.length>8)fail();
  const workstreams=raw.workstreams.map(row=>{
    if(!/^MJ-TH-(RECON|ROADMAP|FLEET)$/.test(row?.key)||!positive(row.issue))fail();
    return {key:row.key,issue:row.issue};
  });
  return {epicIssue:raw.epic_issue,catalogAsOf:raw.as_of,features,coverage,harStatus:raw.audit.har.status,
    blockers:[...new Set(raw.audit.blockers)],projectSync:raw.project?.sync_status==='BLOCKED_AUTH_SCOPE'?'BLOCKED_AUTH_SCOPE':'NOT_VERIFIED',workstreams};
}
function checkSummary(raw){
  const checks=raw?.check_runs;
  const unknown=()=>({state:'UNKNOWN',total:null});
  if(!Array.isArray(checks)||!Number.isSafeInteger(raw.total_count)||checks.length!==raw.total_count||!checks.length||checks.length>100)return unknown();
  const latest=new Map(),identities=new Set();
  for(const check of checks){
    if(!positive(check?.id)||identities.has(check.id)||!positive(check.app?.id)||
       typeof check.name!=='string'||!check.name.trim()||check.name.length>256||
       !['queued','in_progress','completed','waiting','requested','pending'].includes(check.status))return unknown();
    identities.add(check.id);
    // Multiple workflow suites can coexist on one commit. Keep the newest
    // observed check identity for each app/name; never merge different apps.
    const key=JSON.stringify([check.app.id,check.name]),previous=latest.get(key);
    if(!previous||check.id>previous.id)latest.set(key,check);
  }
  const current=[...latest.values()];
  const bad=['failure','timed_out','cancelled','action_required','startup_failure','stale'];
  const state=current.some(c=>bad.includes(c.conclusion))?'FAIL':current.some(c=>c.status!=='completed')?'PENDING':
    current.every(c=>c.conclusion==='success')?'PASS':'UNKNOWN';
  return {state,total:current.length,observedTotal:checks.length,superseded:checks.length-current.length};
}
function createParityTracker({read=githubRead,now=Date.now,ttlMs=600000,minRefreshMs=60000,deadlineMs=25000}={}){
  for(const n of [ttlMs,minRefreshMs,deadlineMs])if(!positive(n))throw Error('Invalid parity timing');
  let snapshot=null,inFlight=null,lastAttempt=-Infinity,nextAttempt=0,failures=0,lastError=null;
  async function collect(signal){
    const get=async route=>{if(signal.aborted)fail();return read(PREFIX+route,signal);};
    const main=await get('git/ref/heads/main');
    if(!SHA.test(main?.object?.sha))fail();
    const sourceSha=main.object.sha;
    const file=await get('contents/docs/talenthop/catalog.json?ref='+sourceSha);
    if(file?.encoding!=='base64'||typeof file.content!=='string'||file.content.length>1_000_000)fail();
    const catalog=catalogProjection(JSON.parse(Buffer.from(file.content,'base64').toString('utf8')));
    const numbers=[...new Set([catalog.epicIssue,...catalog.workstreams.map(w=>w.issue),...catalog.features.flatMap(f=>f.issueNumbers)])];
    if(numbers.length>40)fail();
    const issueRows=await mapBounded(numbers,async n=>{
      const issue=await get('issues/'+n);
      if(issue?.number!==n||!['open','closed'].includes(issue.state)||!date(issue.updated_at)||issue.pull_request)fail();
      return {number:n,state:issue.state,updatedAt:date(issue.updated_at),url:'https://github.com/'+REPO+'/issues/'+n};
    });
    const issues=new Map(issueRows.map(row=>[row.number,row]));
    const pullRows=[];
    for(let page=1;page<=3;page++){
      const rows=await get('pulls?state=open&per_page=100&page='+page);
      if(!Array.isArray(rows)||rows.length>100)fail();
      pullRows.push(...rows);
      if(rows.length<100)break;
      if(page===3)fail();
    }
    const relates=(pull,f)=>{
      const body=typeof pull.body==='string'?pull.body:'';
      return [f.id,...f.requirements].some(id=>new RegExp('(?:^|[^A-Za-z0-9-])'+id.replaceAll('.','\\.')+'(?![A-Za-z0-9.-])').test(body))||
        f.issueNumbers.some(n=>new RegExp('(?:^|[^A-Za-z0-9/])#'+n+'\\b').test(body));
    };
    const relatesWorkstream=(p,w)=>typeof p.body==='string'&&(
      new RegExp('(?:^|[^A-Za-z0-9-])'+w.key+'(?![A-Za-z0-9-])').test(p.body)||
      new RegExp('(?:^|[^A-Za-z0-9/])#'+w.issue+'\\b').test(p.body));
    const related=pullRows.filter(p=>catalog.features.some(f=>relates(p,f))||catalog.workstreams.some(w=>relatesWorkstream(p,w)));
    if(related.length>16)fail();
    const pulls=await mapBounded(related,async p=>{
      if(!positive(p?.number)||!SHA.test(p?.head?.sha)||p.state!=='open')fail();
      let ci={state:'UNKNOWN',total:null};
      try{ci=checkSummary(await get('commits/'+p.head.sha+'/check-runs?per_page=100'));}catch(error){if(error.retryAt)throw error;}
      return {number:p.number,headSha:p.head.sha,state:'OPEN',draft:p.draft===true,ci,
        featureIds:catalog.features.filter(f=>relates(p,f)).map(f=>f.id),url:'https://github.com/'+REPO+'/pull/'+p.number};
    });
    // Recent closed PRs provide exact merge receipts, not proof that a complete
    // feature was delivered. A full page is explicitly a partial history window.
    const closedRows=await get('pulls?state=closed&sort=updated&direction=desc&per_page=100&page=1');
    if(!Array.isArray(closedRows)||closedRows.length>100)fail();
    const mergeWindow={examined:closedRows.length,complete:closedRows.length<100,order:'RECENTLY_UPDATED_CLOSED_PRS'};
    const relatedMerges=closedRows.filter(p=>p?.merged_at&&p?.base?.ref==='main'&&p?.base?.repo?.full_name===REPO)
      .filter(p=>catalog.features.some(f=>relates(p,f))||catalog.workstreams.some(w=>relatesWorkstream(p,w)))
      .map(p=>{
        if(!positive(p.number)||p.state!=='closed'||!date(p.merged_at)||!SHA.test(p.merge_commit_sha))fail();
        return {number:p.number,mergeSha:p.merge_commit_sha,mergedAt:p.merged_at,
          featureIds:catalog.features.filter(f=>relates(p,f)).map(f=>f.id),
          workstreamKeys:catalog.workstreams.filter(w=>relatesWorkstream(p,w)).map(w=>w.key),
          url:'https://github.com/'+REPO+'/pull/'+p.number};
      }).sort((a,b)=>Date.parse(b.mergedAt)-Date.parse(a.mergedAt)||b.number-a.number);
    if(relatedMerges.length>24)fail();
    const claimKeys=new Set([...catalog.workstreams.map(w=>w.key),...catalog.features.flatMap(f=>[f.id,...f.requirements])]);
    const refs=await get('git/matching-refs/heads/webpro-claims/');
    if(!Array.isArray(refs)||refs.length>128)fail();
    const own=refs.filter(r=>typeof r.ref==='string'&&r.ref.startsWith('refs/heads/webpro-claims/')&&claimKeys.has(r.ref.slice(25)));
    if(own.length>24)fail();
    const claims=await mapBounded(own,async r=>{
      if(!SHA.test(r.object?.sha))fail();
      const commit=await get('git/commits/'+r.object.sha);
      if(commit?.sha!==r.object.sha||!date(commit.committer?.date))fail();
      const key=r.ref.slice(25),match=typeof commit.message==='string'?commit.message.match(/\bwebpro-\d{8}T\d{6}Z-[a-f0-9]{4,12}\b/):null;
      return {key,ownerCommit:r.object.sha,runId:match?match[0]:null,createdAt:date(commit.committer.date),
        heartbeat:null,ageIndicator:now()-Date.parse(commit.committer.date)>1800000?'OLDER_THAN_30_MINUTES':'RECENT',
        url:'https://github.com/'+REPO+'/tree/webpro-claims/'+key};
    });
    const discoveryCounts=Object.fromEntries(DISCOVERY.map(s=>[s,0])),implementationCounts=Object.fromEntries(IMPLEMENTATION.map(s=>[s,0]));
    const features=catalog.features.map(f=>{
      discoveryCounts[f.discovery]++;implementationCounts[f.implementation]++;
      const mergedLinks=relatedMerges.filter(m=>m.featureIds.includes(f.id)).slice(0,3)
        .map(({number,mergeSha,mergedAt,url})=>({number,mergeSha,mergedAt,url}));
      return {...f,issues:f.issueNumbers.map(n=>issues.get(n)),pulls:pulls.filter(p=>p.featureIds.includes(f.id)),
        claims:claims.filter(c=>[f.id,...f.requirements].includes(c.key)),relatedMerges:mergedLinks,
        delivery:{state:'NOT_VERIFIED',mergeSha:null,deployedSha:null,accepted:null}};
    });
    return {available:true,sourceSha,syncedAt:new Date(now()).toISOString(),catalogAsOf:catalog.catalogAsOf,
      epicUrl:'https://github.com/'+REPO+'/issues/'+catalog.epicIssue,coverage:catalog.coverage,harStatus:catalog.harStatus,
      blockers:catalog.blockers,projectSync:catalog.projectSync,discoveryCounts,implementationCounts,
      workstreams:catalog.workstreams.map(w=>({...w,issue:issues.get(w.issue),claims:claims.filter(c=>c.key===w.key),
        relatedMerges:relatedMerges.filter(m=>m.workstreamKeys.includes(w.key)).slice(0,3)
          .map(({number,mergeSha,mergedAt,url})=>({number,mergeSha,mergedAt,url}))})),
      features,mergeWindow,deliveryVerification:'NOT_IMPLEMENTED',acceptanceAuthority:'ORIGINAL_MATRICES_UNCHANGED',
      warnings:['PR_LINKS_ARE_REFERENCES','RELATED_MERGES_ARE_NOT_FEATURE_ACCEPTANCE','CHECKS_ARE_NOT_PROTECTED_GATE_ACCEPTANCE','CLAIM_AGE_IS_NOT_A_HEARTBEAT','DEPLOYMENT_AND_PARITY_ACCEPTANCE_NOT_VERIFIED',
        ...(!mergeWindow.complete?['CLOSED_PR_HISTORY_WINDOW_INCOMPLETE']:[])]};
  }
  function view(){
    return {...(snapshot||{available:false,features:[],workstreams:[]}),stale:!snapshot||lastError!==null||now()-Date.parse(snapshot.syncedAt)>=ttlMs,
      error:lastError,nextRefreshAt:new Date(Math.max(nextAttempt,lastAttempt+minRefreshMs)).toISOString()};
  }
  async function status({refresh=false}={}){
    if(inFlight)return inFlight;
    if(now()<nextAttempt||now()-lastAttempt<minRefreshMs||(!refresh&&lastError===null&&snapshot&&now()-Date.parse(snapshot.syncedAt)<ttlMs))return view();
    lastAttempt=now();
    const controller=new AbortController();let timer;
    const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('PARITY_DEADLINE'));},deadlineMs);});
    inFlight=(async()=>{
      try{snapshot=await Promise.race([collect(controller.signal),deadline]);lastError=null;failures=0;nextAttempt=now()+minRefreshMs;}
      catch(error){lastError='GITHUB_EVIDENCE_UNAVAILABLE';failures++;nextAttempt=Math.max(now()+Math.min(900000,60000*2**Math.min(failures-1,4)),Number.isSafeInteger(error.retryAt)?error.retryAt:0);}
      finally{clearTimeout(timer);controller.abort();inFlight=null;}
      return view();
    })();
    return inFlight;
  }
  return {status};
}
module.exports={createParityTracker,catalogProjection,checkSummary,githubRead,parseGitHubResponse};
