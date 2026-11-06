'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SOURCES, projectSnapshot, collectSnapshot, writeSnapshot } = require('./export-status');
const { freshness, displayModel } = require('./public/app');

const NOW = Date.parse('2026-10-26T01:00:00Z');
const ISO = new Date(NOW).toISOString();
function fixture() {
  const phaseCounts=[8,14,9,4,18,7];let number=1;
  const phaseLabels=['Setup and résumé (1–8)','Job sources and matching (9–22)','Employer discovery (23–31)','Tailored documents (32–35)','Applications and tracking (36–53)','Restart and recovery (54–60)'];
  const phases=phaseCounts.map((total,phase)=>({id:String.fromCharCode(65+phase),label:phaseLabels[phase],steps:Array.from({length:total},()=>{
    const stepNumber=number++,status=stepNumber<=7?'PASS':stepNumber<=40?'PARTIAL':'NOT_RUN';
    return {number:stepNumber,title:'Step '+stepNumber,status,...(stepNumber===1?{observed_result:'C:\\Users\\Dylan\\private\\token=SECRET_STEP',remaining_gap:'Complete remaining local work.',tested_commit:'d'.repeat(40),executed_at_utc:ISO,review_status:'APPROVED',merge_status:'UNMERGED'}:stepNumber===2?{observed_result:'Synthetic acceptance verified.'}:{})};
  })}));
  const priorityDefinitions=[['P0',14,4,8],['P1',108,8,0],['P2',37,22,28],['P3',17,16,6],['P4',0,18,26],['P5',7,14,21],['P6',0,0,12]];
  const requirements=[{id:'MJ-REQ-290',title:'Other not run P0',status:'NOT_RUN',priority:'P0',issue:null},
    {id:'MJ-REQ-292',title:'End-to-end acceptance test',status:'PARTIAL',priority:'P0',issue:293}];let requirementNumber=1;
  for(const [name,passes,partials,notRun] of priorityDefinitions){
    const reserved=name==='P0'?{PASS:passes,PARTIAL:partials-1,NOT_RUN:notRun-1}:{PASS:passes,PARTIAL:partials,NOT_RUN:notRun};
    for(const [status,total] of Object.entries(reserved))for(let i=0;i<total;i++){
      while([290,292].includes(requirementNumber))requirementNumber++;
      requirements.push({id:'MJ-REQ-'+String(requirementNumber++).padStart(3,'0'),title:'Requirement '+requirementNumber,status,priority:name,issue:null});
    }
  }
  const data = {
    fleetHealth: {ok:true,dispatchBlockedReason:null},
    fleetState: {timestamp:ISO,summary:{total:2,working:1,idle:1},sessions:[
      {id:'mjobs-1',name:'Developer',model:'gpt-6.1',harness:'codex',role:'Implementation',busy:true,isIdle:false,activity:'working',controllerState:'busy',controllerVerified:true,openPRs:1,prompt:'SECRET_PROMPT',path:'C:\\private',token:'SECRET_TOKEN'},
      {id:'mjobs-2',name:'Reviewer',model:'gpt-6',harness:'codex',role:'Review',busy:false,isIdle:true,activity:'idle',controllerState:'ready',controllerVerified:true},
    ]},
    fleetMaster: {timestamp:ISO,dispatch:{sustainedEnabled:true,turboEnabled:false},emergency:{latched:false},restore:{phase:'completed',active:false},startup:{phase:'completed',active:false,reconciliationRequired:false,ownerId:'PRIVATE_OWNER',error:null},currentReadiness:{at:ISO,total:2,verified:2,ready:true,runtimesReady:true,dispatchPaused:false,healthyIds:['SECRET_NATIVE_ID']}},
    quota: {fresh:true,monitorOnline:true,sampledAt:ISO,selectedRemainingPercent:88,guardAcknowledged:true,config:{autoKillArmed:true,thresholdPercent:7},windows:[{label:'5 hours',remainingPercent:88,resetsAt:'2026-10-26T05:00:00Z'}],token:'SECRET_QUOTA'},
    missionHealth: {service:'mjobs-mission-control',status:'ready',root:'C:\\private'},
    missionState: {time:ISO,lanes:{codex:{config:{model:'gpt-6.1',reasoning_effort:'high',prompt_override:'SECRET_OVERRIDE'},runtime:{status:'running',pid:999},activity:{state:'working',process_tree:[{command:'SECRET_COMMAND'}]},log_tail:'SECRET_LOG',command:'SECRET_COMMAND'}}},
    acceptanceProgress: {available:true,observed_at:ISO,original:{pass:183,partial:82,not_run:101,total:366},reference:{pass:19,partial:4,not_run:36,total:59},priorities:[
      {name:'P0',pass:14,partial:4,not_run:8,total:26},{name:'P1',pass:108,partial:8,not_run:0,total:116},
      {name:'P2',pass:37,partial:22,not_run:28,total:87},{name:'P3',pass:17,partial:16,not_run:6,total:39},
      {name:'P4',pass:0,partial:18,not_run:26,total:44},{name:'P5',pass:7,partial:14,not_run:21,total:42},
      {name:'P6',pass:0,partial:0,not_run:12,total:12}]},
    campaignProgress: {schema_version:1,available:true,observed_at:ISO,
      overview:{original:{pass:183,partial:82,not_run:101,total:366},reference:{pass:19,partial:4,not_run:36,total:59},priorities:{
        P0:{pass:14,partial:4,not_run:8,total:26},P1:{pass:108,partial:8,not_run:0,total:116},
        P2:{pass:37,partial:22,not_run:28,total:87},P3:{pass:17,partial:16,not_run:6,total:39},
        P4:{pass:0,partial:18,not_run:26,total:44},P5:{pass:7,partial:14,not_run:21,total:42},P6:{pass:0,partial:0,not_run:12,total:12}}},
      requirements:requirements.map(item=>item.id==='MJ-REQ-292'?{...item,private:'SECRET_FIELD'}:item),
      campaigns:[{requirement_id:'MJ-REQ-292',title:'P0 acceptance <img src=x onerror=alert(1)>',issue_url:'https://github.com/MulattoTech/MJobs/issues/293',updated_at_utc:ISO,
        source_revision:'a'.repeat(40),handoff_revision:'b'.repeat(40),ledger_sha256:'c'.repeat(64),source_kind:'working_tree',acceptance_claim_scope:'Synthetic local journey only',
        scoreboard:{total:60,verified_pass:7,PARTIAL:33,NOT_RUN:20,FAIL:0,BLOCKED:0},phases,routing_state:'PAUSED',routing_state_scope:'recorded checkpoint; not live process state',
        blockers:['No external submission is enabled','C:\\Users\\Dylan\\private\\token=SECRET_TOKEN','Independent review remains pending.'],next_action:'<svg onload=alert(1)>'}]},
  };
  return Object.fromEntries(Object.entries(data).map(([name,value])=>[name,{available:true,checkedAt:ISO,data:value}]));
}

test('only operational allowlisted fields leave the local control planes',()=>{
  const snapshot=projectSnapshot(fixture(),NOW),serialized=JSON.stringify(snapshot);
  for(const forbidden of ['SECRET_','PRIVATE_OWNER','C:\\private','process_tree','log_tail','prompt_override','"token"','"pid"'])assert.equal(serialized.includes(forbidden),false,forbidden);
  assert.equal(snapshot.readOnly,true);assert.equal(snapshot.dispatch.state,'enabled');
  assert.equal(snapshot.fleet.summary.working,1);assert.equal(snapshot.quota.remainingPercent,88);
  assert.equal(snapshot.missionControl.lanes[0].model,'gpt-6.1, gpt-6');
  assert.equal(snapshot.missionControl.lanes[0].agents,2);
  assert.equal(snapshot.missionControl.lanes[0].status,'WORKING');
  assert.equal(displayModel(snapshot,NOW).verified,'2 / 2');
  assert.equal(snapshot.acceptance.original.total,366);assert.equal(snapshot.acceptance.reference.total,59);
  assert.deepEqual(snapshot.acceptance.priorities.map(x=>x.name),['P0','P1','P2','P3','P4','P5','P6']);
  assert.ok(snapshot.campaignProgress.requirements.some(item=>item.id==='MJ-REQ-292'));
  assert.equal(snapshot.campaignProgress.campaigns[0].phases.length,6);
  assert.equal(snapshot.campaignProgress.campaigns[0].phases.flatMap(x=>x.steps).length,60);
  assert.equal(snapshot.campaignProgress.campaigns[0].blockers[1],null);
  assert.equal(snapshot.campaignProgress.campaigns[0].nextAction,'<svg onload=alert(1)>','untrusted markup remains inert text, not HTML');
  assert.equal(snapshot.campaignProgress.campaigns[0].phases[0].steps[0].remainingGap,'Complete remaining local work.');
  assert.equal(JSON.stringify(snapshot).includes('SECRET_FIELD'),false);
  assert.equal(JSON.stringify(snapshot).includes('SECRET_TOKEN'),false);
  assert.equal(displayModel(snapshot,NOW).campaignProgress.available,true);
  const element=(tag)=>({tag,className:'',dataset:{},open:false,children:[],_text:'',set textContent(value){this._text=String(value??'');this.children=[];},get textContent(){return this._text+this.children.map(child=>typeof child==='string'?child:child.textContent).join('');},append(...values){for(const value of values)this.children.push(value);},replaceChildren(...values){this._text='';this.children=[...values];}});
  const root=element('div'),doc={getElementById:id=>id==='acceptance-content'?root:null,createElement:tag=>element(tag)};
  const create=(tag,text,className)=>{const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
  require('./public/app').renderAcceptance(doc,displayModel(snapshot,NOW),create,value=>value||'Unknown');
  assert.match(fs.readFileSync(path.join(__dirname,'public','index.html'),'utf8'),/aria-label="Overall acceptance"/);
  assert.match(root.textContent,/P0 · 14\/26 PASS/);
  assert.match(root.textContent,/MJ-REQ-292/);assert.match(root.textContent,/Setup and résumé \(1–8\)/);assert.match(root.textContent,/Step 1:/);
  assert.match(root.textContent,/Observed result:/);assert.match(root.textContent,/Tested commit:/);assert.match(root.textContent,/Review state: APPROVED/);
  assert.match(root.textContent,/Merged acceptance: each step’s merge state is shown separately/);
  assert.match(root.textContent,/campaign 7 PASS · 33 PARTIAL · 20 NOT_RUN/);
  assert.match(root.textContent,/Source checkpoint:/);assert.match(root.textContent,/Handoff checkpoint: .*differs from source/);
  assert.match(root.textContent,/Last recorded checkpoint state: PAUSED · recorded checkpoint; not live process state/);
  assert.match(root.textContent,/Evidence and source/);assert.match(root.textContent,/Blocker: No external submission is enabled/);
  assert.match(root.textContent,/Next action:/);assert.match(root.textContent,/All recorded blockers \(2\)/);
  assert.doesNotMatch(root.textContent,/0 FAIL|0 BLOCKED/,'zero-valued failure states are omitted from phase summaries');
  assert.match(root.textContent,/Remaining gap:/);
  assert.match(root.textContent,/<svg onload=alert\(1\)>/);assert.doesNotMatch(root.textContent,/SECRET_STEP|SECRET_TOKEN|C:\\Users/);
});

test('campaign disclosures stay first in P0 and preserve keyed open state through stale and changed snapshots',()=>{
  const data=fixture(),snapshot=projectSnapshot(data,NOW),model=displayModel(snapshot,NOW);
  const element=(tag)=>({tag,className:'',dataset:{},open:false,children:[],_text:'',set textContent(value){this._text=String(value??'');this.children=[];},get textContent(){return this._text+this.children.map(child=>typeof child==='string'?child:child.textContent).join('');},append(...values){for(const value of values)this.children.push(value);},replaceChildren(...values){this._text='';this.children=[...values];}});
  const root=element('div'),doc={getElementById:id=>id==='acceptance-content'?root:null,createElement:tag=>element(tag)};
  const create=(tag,text,className)=>{const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
  const find=(node,key)=>{if(node.dataset?.disclosureKey===key)return node;for(const child of node.children||[]){if(typeof child!=='string'){const found=find(child,key);if(found)return found;}}return null;};
  const state=new Map();
  require('./public/app').renderAcceptance(doc,model,create,value=>value||'Unknown',state);
  assert.equal(find(root,'priority:P0').children[1].dataset.disclosureKey,'requirement:MJ-REQ-292','campaign-backed requirement sorts before other P0 rows');
  const row=find(root,'requirement:MJ-REQ-292');assert.equal(row.open,false,'large campaign drilldown starts collapsed');
  row.open=true;find(root,'phase:MJ-REQ-292:A').open=true;find(root,'step:MJ-REQ-292:1').open=true;
  find(root,'evidence:MJ-REQ-292').open=true;find(root,'blockers:MJ-REQ-292').open=true;
  const changed=structuredClone(model);changed.campaignProgress.campaigns[0].sourceRevision='f'.repeat(40);
  require('./public/app').renderAcceptance(doc,changed,create,value=>value||'Unknown',state);
  assert.equal(find(root,'requirement:MJ-REQ-292').open,true);assert.equal(find(root,'phase:MJ-REQ-292:A').open,true);assert.equal(find(root,'step:MJ-REQ-292:1').open,true);
  assert.equal(find(root,'evidence:MJ-REQ-292').open,true);assert.equal(find(root,'blockers:MJ-REQ-292').open,true);
  const unavailable=displayModel({...snapshot,generatedAt:new Date(NOW-46000).toISOString()},NOW);
  require('./public/app').renderAcceptance(doc,unavailable,create,value=>value||'Unknown',state);
  assert.match(root.textContent,/Acceptance progress unavailable/);
  require('./public/app').renderAcceptance(doc,model,create,value=>value||'Unknown',state);
  assert.equal(find(root,'requirement:MJ-REQ-292').open,true);assert.equal(find(root,'phase:MJ-REQ-292:A').open,true);assert.equal(find(root,'step:MJ-REQ-292:1').open,true);
  assert.equal(find(root,'evidence:MJ-REQ-292').open,true);assert.equal(find(root,'blockers:MJ-REQ-292').open,true);
});

test('quota armed with a full allowance is distinct from working or dispatch enabled',()=>{
  const data=fixture();data.quota.data.selectedRemainingPercent=100;data.fleetMaster.data.dispatch.sustainedEnabled=false;
  data.fleetState.data.summary.working=0;for(const session of data.fleetState.data.sessions){session.busy=false;session.activity='idle';}
  const snapshot=projectSnapshot(data,NOW);assert.equal(snapshot.quota.armed,true);assert.equal(snapshot.quota.remainingPercent,100);
  assert.equal(snapshot.dispatch.state,'paused');assert.equal(snapshot.fleet.summary.working,0);
});

test('enabled scheduler GitHub holds are shown truthfully without exporting raw errors',()=>{
  const data=fixture();
  data.fleetHealth.data.dispatchBlockedReason='GitHub snapshot unavailable or stale; no automatic assignments';
  let snapshot=projectSnapshot(data,NOW);
  assert.equal(snapshot.dispatch.state,'blocked');
  assert.equal(snapshot.dispatch.sustainedEnabled,true,'configured enabled remains distinct from able to dispatch');
  assert.equal(snapshot.dispatch.reason,'GitHub repository inventory is unavailable or stale');
  data.fleetHealth.data.dispatchBlockedReason='GitHub snapshot unavailable or stale; no automatic assignments: private token C:\\secret';
  snapshot=projectSnapshot(data,NOW);
  assert.equal(snapshot.dispatch.reason,'Local control plane reports a dispatch hold');
  assert.equal(JSON.stringify(snapshot).includes('private token'),false);
  assert.equal(JSON.stringify(snapshot).includes('C:\\secret'),false);
  data.fleetHealth.data.dispatchBlockedReason=null;
  assert.equal(projectSnapshot(data,NOW).dispatch.state,'enabled','a recovered planner removes the display hold');
});

test('failed sources never reuse previous healthy metrics or lanes',()=>{
  const data=fixture();for(const name of Object.keys(data))data[name]={available:false,error:'UNAVAILABLE',data:data[name].data};
  const snapshot=projectSnapshot(data,NOW);assert.equal(snapshot.dispatch.state,'unknown');
  assert.equal(snapshot.fleet.runtimeAvailable,false);assert.equal(snapshot.fleet.summary.working,null);
  assert.equal(snapshot.quota.fresh,false);assert.equal(snapshot.quota.remainingPercent,null);assert.equal(snapshot.quota.armed,null);
  assert.deepEqual(snapshot.fleet.sessions,[]);assert.deepEqual(snapshot.missionControl.lanes,[]);
});

test('preserved offline rosters cannot appear as a running fleet',()=>{
  const data=fixture();data.fleetState.data.offline=true;
  const snapshot=projectSnapshot(data,NOW);assert.equal(snapshot.fleet.runtimeAvailable,false);
  assert.equal(snapshot.fleet.preservedSnapshot,true);assert.equal(snapshot.fleet.summary.working,0);
  assert.equal(snapshot.dispatch.state,'unknown');assert.equal(snapshot.fleet.sessions.some(session=>session.busy),false);
  assert.equal(snapshot.fleet.sessions.some(session=>session.controllerVerified===true),false);
});

test('stale quota does not publish numeric allowance or historical quota windows',()=>{
  const data=fixture();data.quota.data.fresh=false;
  const snapshot=projectSnapshot(data,NOW);assert.equal(snapshot.quota.remainingPercent,null);assert.deepEqual(snapshot.quota.windows,[]);
});

test('an old provider sample cannot gain freshness from a new exporter timestamp',()=>{
  const data=fixture();data.quota.data.sampledAt=new Date(NOW-46000).toISOString();
  const snapshot=projectSnapshot(data,NOW);assert.equal(snapshot.quota.fresh,false);assert.equal(snapshot.quota.remainingPercent,null);
});

test('pending or stale runtime inspection never claims verified healthy controllers',()=>{
  const data=fixture();data.fleetMaster.data.currentReadiness.inspectionPending=true;
  let snapshot=projectSnapshot(data,NOW);assert.equal(snapshot.readiness.available,false);assert.equal(snapshot.readiness.verified,null);
  assert.equal(displayModel(snapshot,NOW).verified,'—');
  data.fleetMaster.data.currentReadiness.inspectionPending=false;data.fleetMaster.data.currentReadiness.at=new Date(NOW-46000).toISOString();
  snapshot=projectSnapshot(data,NOW);assert.equal(snapshot.readiness.available,false);assert.equal(snapshot.readiness.runtimesReady,null);
});

test('UI clears live claims after the exporter stops or the clock is invalid',()=>{
  const snapshot=projectSnapshot(fixture(),NOW);
  assert.equal(freshness(snapshot,NOW+44000).stale,false);
  const display=displayModel(snapshot,NOW+46000);assert.equal(display.stale,true);
  assert.equal(display.dispatch,'Unknown');assert.equal(display.working,'—');assert.equal(display.quota,'—');
  assert.equal(display.acceptance,null);assert.equal(display.campaignProgress.available,false);
  assert.deepEqual(display.sessions,[]);assert.deepEqual(display.lanes,[]);
  assert.equal(freshness({...snapshot,generatedAt:'invalid'},NOW).stale,true);
  assert.equal(freshness({...snapshot,generatedAt:new Date(NOW+20000).toISOString()},NOW).stale,true);
});

test('UI expires provider and inspector observations before a newer publication expires',()=>{
  const data=fixture();
  data.quota.data.sampledAt=new Date(NOW-40000).toISOString();
  data.fleetMaster.data.currentReadiness.at=new Date(NOW-40000).toISOString();
  data.acceptanceProgress.data.observed_at=new Date(NOW-40000).toISOString();
  data.campaignProgress.data.observed_at=new Date(NOW-40000).toISOString();
  const snapshot=projectSnapshot(data,NOW);
  assert.equal(displayModel(snapshot,NOW+4000).quota,'88%');
  assert.equal(displayModel(snapshot,NOW+4000).verified,'2 / 2');
  const later=displayModel(snapshot,NOW+6000);
  assert.equal(later.stale,false,'publication remains fresh');
  assert.equal(later.quota,'—','provider observation expired independently');
  assert.equal(later.verified,'—','runtime inspection expired independently');
  assert.equal(later.acceptance,null,'acceptance totals expire with their source observation');
  assert.equal(later.campaignProgress.available,false,'campaign detail expires with its source observation');
});

test('exporter uses only fixed loopback GET routes and rejects redirected/error/stale responses',async()=>{
  const data=fixture(),calls=[];
  const fakeFetch=async(url,options)=>{
    calls.push({url,options});const name=Object.keys(SOURCES).find(key=>SOURCES[key]===url);
    if(name==='quota')return new Response('login html',{status:302});
    const item=structuredClone(data[name].data);if(name==='fleetState')item.timestamp='2026-10-25T01:00:00Z';
    return new Response(JSON.stringify(item),{headers:{'content-type':'application/json'}});
  };
  const snapshot=await collectSnapshot(fakeFetch,()=>NOW);
  assert.equal(calls.length,8);for(const call of calls){assert.equal(new URL(call.url).hostname,'127.0.0.1');assert.equal(call.options.method,'GET');assert.equal(call.options.redirect,'error');}
  assert.equal(snapshot.sources.fleetState.error,'STALE_SOURCE');assert.equal(snapshot.fleet.runtimeAvailable,false);
  assert.equal(snapshot.sources.quota.available,false);assert.equal(snapshot.quota.remainingPercent,null);
});

test('campaign progress requires a fresh complete six-phase 60-step snapshot',async()=>{
  const data=fixture();data.campaignProgress.data.campaigns[0].phases[5].steps.pop();
  const snapshot=await collectSnapshot(async url=>{
    const name=Object.keys(SOURCES).find(key=>SOURCES[key]===url);
    return new Response(JSON.stringify(data[name].data));
  },()=>NOW);
  assert.equal(snapshot.sources.campaignProgress.available,false);
  assert.equal(snapshot.campaignProgress.available,false);
  assert.deepEqual(snapshot.campaignProgress.campaigns,[]);
  assert.notEqual(snapshot.campaignProgress.total,0,'missing campaign data must not synthesize zero progress');
});

test('campaign score and canonical overview must match the requirement rows and current totals',async()=>{
  const data=fixture();data.campaignProgress.data.campaigns[0].scoreboard.PARTIAL=32;data.campaignProgress.data.campaigns[0].scoreboard.NOT_RUN=21;
  const scoreMismatch=await collectSnapshot(async url=>{
    const name=Object.keys(SOURCES).find(key=>SOURCES[key]===url);return new Response(JSON.stringify(data[name].data));
  },()=>NOW);
  assert.equal(scoreMismatch.sources.campaignProgress.available,false,'step status rows are authoritative for the step scoreboard');
  assert.equal(scoreMismatch.campaignProgress.available,false);

  const inconsistent=fixture();inconsistent.campaignProgress.data.overview.priorities.P0.partial++;
  const overviewMismatch=await collectSnapshot(async url=>{
    const name=Object.keys(SOURCES).find(key=>SOURCES[key]===url);return new Response(JSON.stringify(inconsistent[name].data));
  },()=>NOW);
  assert.equal(overviewMismatch.sources.campaignProgress.available,false,'campaign catalog cannot disagree with the current acceptance snapshot');
  assert.equal(overviewMismatch.acceptance.available,true,'canonical current totals remain visible');
  assert.equal(overviewMismatch.campaignProgress.campaigns.length,0,'inconsistent rows never synthesize or retain details');

  const endpointRace=fixture();endpointRace.acceptanceProgress.data.priorities[0].partial++;
  endpointRace.acceptanceProgress.data.priorities[0].not_run--;
  endpointRace.acceptanceProgress.data.original.partial++;
  endpointRace.acceptanceProgress.data.original.not_run--;
  const raced=await collectSnapshot(async url=>{
    const name=Object.keys(SOURCES).find(key=>SOURCES[key]===url);return new Response(JSON.stringify(endpointRace[name].data));
  },()=>NOW);
  assert.equal(raced.acceptance.available,true,'each independent aggregate remains internally valid');
  assert.equal(raced.sources.campaignProgress.available,false,'different acceptance snapshots cannot be combined');
  assert.equal(raced.campaignProgress.available,false);
});

test('unsafe or omitted optional next action does not invalidate a consistent campaign',async()=>{
  const data=fixture();delete data.campaignProgress.data.campaigns[0].next_action;
  const snapshot=await collectSnapshot(async url=>{
    const name=Object.keys(SOURCES).find(key=>SOURCES[key]===url);return new Response(JSON.stringify(data[name].data));
  },()=>NOW);
  assert.equal(snapshot.sources.campaignProgress.available,true);
  assert.equal(snapshot.campaignProgress.available,true);
  assert.equal(snapshot.campaignProgress.campaigns[0].nextAction,null);
  const unsafe=fixture();unsafe.campaignProgress.data.campaigns[0].next_action='C:\\Users\\Dylan\\private\\secret=hidden';
  const redacted=await collectSnapshot(async url=>{
    const name=Object.keys(SOURCES).find(key=>SOURCES[key]===url);return new Response(JSON.stringify(unsafe[name].data));
  },()=>NOW);
  assert.equal(redacted.campaignProgress.available,true);
  assert.equal(redacted.campaignProgress.campaigns[0].nextAction,null);
});

test('campaign endpoint unavailability is not projected as a healthy source',()=>{
  const data=fixture();data.campaignProgress.data.available=false;data.campaignProgress.data.requirements=[];data.campaignProgress.data.campaigns=[];
  const snapshot=projectSnapshot(data,NOW);
  assert.equal(snapshot.campaignProgress.available,false);assert.deepEqual(snapshot.campaignProgress.campaigns,[]);
  assert.equal(snapshot.sources.campaignProgress.available,false);
});

test('stale acceptance and campaign sources lose their current claims',async()=>{
  const data=fixture();
  data.acceptanceProgress.data.observed_at=new Date(NOW-46000).toISOString();
  data.campaignProgress.data.observed_at=new Date(NOW-46000).toISOString();
  const snapshot=await collectSnapshot(async url=>{
    const name=Object.keys(SOURCES).find(key=>SOURCES[key]===url);
    return new Response(JSON.stringify(data[name].data));
  },()=>NOW);
  assert.equal(snapshot.sources.acceptanceProgress.error,'STALE_SOURCE');
  assert.equal(snapshot.sources.campaignProgress.error,'STALE_SOURCE');
  assert.equal(snapshot.acceptance.available,false);assert.equal(snapshot.campaignProgress.available,false);
  assert.deepEqual(snapshot.campaignProgress.requirements,[]);
});

test('bounded master retries observe a settling runtime inspection using one shared deadline',async()=>{
  const data=fixture(),masterSignals=[];let masterCalls=0;
  const snapshot=await collectSnapshot(async(url,options)=>{
    const name=Object.keys(SOURCES).find(key=>SOURCES[key]===url),item=structuredClone(data[name].data);
    if(name==='fleetMaster'){
      masterCalls++;masterSignals.push(options.signal);
      item.currentReadiness.inspectionPending=masterCalls<3;
      if(masterCalls<3){item.currentReadiness.stale=true;item.currentReadiness.verified=0;}
    }
    return new Response(JSON.stringify(item));
  },()=>NOW);
  assert.equal(masterCalls,3);assert.equal(masterSignals.every(signal=>signal===masterSignals[0]),true);
  assert.equal(snapshot.readiness.available,true);assert.equal(snapshot.readiness.verified,2);
});

test('persistent pending inspection stops after three GETs and remains unverified',async()=>{
  const data=fixture();let masterCalls=0;
  const snapshot=await collectSnapshot(async url=>{
    const name=Object.keys(SOURCES).find(key=>SOURCES[key]===url),item=structuredClone(data[name].data);
    if(name==='fleetMaster'){masterCalls++;item.currentReadiness.inspectionPending=true;}
    return new Response(JSON.stringify(item));
  },()=>NOW);
  assert.equal(masterCalls,3);assert.equal(snapshot.readiness.available,false);
  assert.equal(snapshot.readiness.verified,null);assert.equal(snapshot.readiness.runtimesReady,null);
  assert.equal(displayModel(snapshot,NOW).verified,'—');
});

test('response size and malformed payloads fail closed without exporting response text',async()=>{
  const snapshot=await collectSnapshot(async()=>new Response('SECRET_BODY',{headers:{'content-length':String(3*1024*1024)}}),()=>NOW);
  assert.equal(Object.values(snapshot.sources).every(source=>source.error==='RESPONSE_TOO_LARGE'),true);
  assert.equal(JSON.stringify(snapshot).includes('SECRET_BODY'),false);
  const invalid=await collectSnapshot(async()=>new Response('{broken SECRET_BODY'),()=>NOW);
  assert.equal(Object.values(invalid.sources).every(source=>!source.available),true);
});

test('snapshot replacement is atomic and leaves no temporary files',()=>{
  const output=fs.mkdtempSync(path.join(os.tmpdir(),'mjobs-remote-'));
  try{writeSnapshot(output,projectSnapshot(fixture(),NOW));writeSnapshot(output,projectSnapshot({},NOW+10000));
    const value=JSON.parse(fs.readFileSync(path.join(output,'status.json'),'utf8'));
    assert.equal(value.generatedAt,new Date(NOW+10000).toISOString());assert.equal(value.fleet.runtimeAvailable,false);
    assert.deepEqual(fs.readdirSync(output),['status.json']);
  }finally{fs.rmSync(output,{recursive:true,force:true});}
});
