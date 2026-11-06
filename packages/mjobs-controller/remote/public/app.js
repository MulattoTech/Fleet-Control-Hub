(function(root, factory) {
  'use strict';
  const exported = factory();
  if (typeof module === 'object' && module.exports) module.exports = exported;
  if (typeof document !== 'undefined') exported.start(document);
})(typeof globalThis === 'object' ? globalThis : this, function() {
  'use strict';
  const labels = {fleetHealth:'Fleet service',fleetState:'Live fleet observations',fleetMaster:'Startup and dispatch',quota:'Codex quota',missionHealth:'Mission Control service',missionState:'Mission Control lanes',acceptanceProgress:'Overall acceptance',campaignProgress:'P0 campaign checkpoint'};
  function freshness(snapshot, now = Date.now()) {
    const age = (now - Date.parse(snapshot?.generatedAt || '')) / 1000;
    const valid = snapshot?.schemaVersion === 1 && snapshot?.readOnly === true && Number.isFinite(age) && age >= -10;
    return { stale: !valid || age > 45, age: Number.isFinite(age) ? Math.max(0,Math.floor(age)) : null };
  }
  function displayModel(snapshot, now = Date.now()) {
    const fresh = freshness(snapshot, now);
    if (fresh.stale) return { ...fresh, dispatch:'Unknown', dispatchDetail:'Status feed is stale; current dispatch cannot be verified',working:'—',agentsDetail:'Current agent activity is unknown',verified:'—',verifiedDetail:'Current runtime health is unknown',quota:'—',quotaDetail:'Current allowance is unknown',startup:'Unknown',startupDetail:'Current startup state is unknown',sessions:[],lanes:[],acceptance:null,campaignProgress:{available:false,requirements:[],campaigns:[]} };
    const s = snapshot, total = s.fleet?.summary?.total;
    // A recently published snapshot can contain an older provider/inspector
    // observation. Expire those observations independently as the page ages.
    const sourceFresh = value => {const age=now-Date.parse(value || '');return Number.isFinite(age)&&age>=-10000&&age<=45000;};
    const readinessFresh = s.readiness?.available && sourceFresh(s.readiness.observedAt);
    const quotaFresh = s.quota?.fresh && sourceFresh(s.quota.sampledAt);
    const acceptanceFresh = s.acceptance?.available && sourceFresh(s.acceptance.observedAt);
    const campaignFresh = s.campaignProgress?.available && sourceFresh(s.campaignProgress.observedAt);
    return { ...fresh,
      dispatch: ({enabled:'Enabled',paused:'Paused',blocked:'Blocked',unknown:'Unknown'})[s.dispatch?.state] || 'Unknown',
      dispatchDetail:s.dispatch?.reason || 'Dispatch status is unavailable',
      working:s.fleet?.runtimeAvailable && Number.isFinite(s.fleet?.summary?.working) ? String(s.fleet.summary.working) : '—',
      agentsDetail:s.fleet?.preservedSnapshot ? 'Saved roster only; live runtime unavailable' : !s.fleet?.runtimeAvailable ? 'Live fleet runtime is unavailable' : Number.isFinite(total) ? total+' agents observed · '+(s.fleet.summary.idle ?? '—')+' idle' : 'No live count available',
      verified:readinessFresh ? s.readiness.verified+' / '+s.readiness.total : '—',
      verifiedDetail:s.readiness?.inspectionPending ? 'Runtime inspection is in progress' : !readinessFresh ? 'Current runtime inspection is unavailable or stale' : s.readiness.runtimesReady===true ? 'Every expected runtime is verified' : (s.readiness.total-s.readiness.verified)+' expected runtimes are not verified',
      quota:quotaFresh && Number.isFinite(s.quota?.remainingPercent) ? s.quota.remainingPercent+'%' : '—',
      quotaDetail:!quotaFresh ? 'Quota telemetry unavailable or stale' : (s.quota.monitoredWindow || 'Selected window')+' remaining · guard '+(s.quota.armed === true ? (s.quota.guardAcknowledged === true ? 'armed and acknowledged' : 'awaiting acknowledgement') : 'not armed'),
      startup:s.startup?.available && s.startup?.phase ? s.startup.phase.replaceAll('_',' ') : 'Unknown',
      startupDetail:s.startup?.reconciliationRequired ? 'Reconciliation required on the PC' : s.startup?.errorCode || (s.startup?.restorePhase ? 'Restore: '+s.startup.restorePhase : 'No current restoration result'),
      sessions:Array.isArray(s.fleet?.sessions) ? s.fleet.sessions.map(agent=>agent.runtimeVerified&&!sourceFresh(agent.runtimeObservedAt)?{...agent,runtimeVerified:false,runtimeStatus:'Verification unavailable',controllerLabel:agent.mode==='tui'?'Terminal · verification unavailable':'Chat · '+(agent.controllerState||'not reported')}:agent) : [],
      lanes:s.missionControl?.available && Array.isArray(s.missionControl?.lanes) ? s.missionControl.lanes : [],
      acceptance:acceptanceFresh?s.acceptance:null,
      campaignProgress:campaignFresh?s.campaignProgress:{available:false,observedAt:null,requirements:[],campaigns:[]},
    };
  }
  function renderAcceptance(doc,model,create,localTime) {
    const root=doc.getElementById('acceptance-content');
    if(!root)return;
    root.replaceChildren();
    if(!model.acceptance) {root.append(create('p','Acceptance progress unavailable. No current totals are reported.','empty'));return;}
    const overview=create('div',undefined,'acceptance-overview');
    for(const [label,value] of [['Original requirements',model.acceptance.original],['Additional references',model.acceptance.reference]]) {
      const card=create('article',undefined,'acceptance-metric');
      card.append(create('span',label),create('strong',value?value.pass+' / '+value.total+' PASS':'Unavailable'));
      card.append(create('small',value?value.partial+' PARTIAL · '+value.notRun+' NOT_RUN':'No current totals'));
      overview.append(card);
    }
    root.append(overview);
    const reqs=model.campaignProgress?.available?model.campaignProgress.requirements:[];
    const campaigns=new Map((model.campaignProgress?.campaigns||[]).map(item=>[item.requirementId,item]));
    const priorities=create('div',undefined,'acceptance-priorities');
    const priorityRows=[...(model.acceptance.priorities||[])].sort((a,b)=>a.name.localeCompare(b.name));
    for(const counts of priorityRows) {
      const disclosure=create('details',undefined,'priority-group');
      if(counts.name==='P0')disclosure.open=true;
      disclosure.append(create('summary',counts.name+' · '+counts.pass+'/'+counts.total+' PASS · '+counts.partial+' PARTIAL · '+counts.notRun+' NOT_RUN'));
      const items=reqs.filter(item=>item.priority===counts.name).sort((a,b)=>a.id.localeCompare(b.id));
      if(!model.campaignProgress?.available) {
        disclosure.append(create('p',counts.name==='P0'?'MJ-REQ-292 · Campaign details unavailable.':'Requirement details unavailable.','empty'));
      } else {
        for(const item of items) {
          const row=create('details',undefined,'requirement-group');
          if(item.id==='MJ-REQ-292')row.open=true;
          const summary=create('summary',item.id+' · '+item.title+' · '+item.status);
          if(Number.isInteger(item.issue)&&item.issue>0) {
            const issue=create('a','#'+item.issue,'issue-link');issue.href='https://github.com/MulattoTech/MJobs/issues/'+item.issue;
            issue.target='_blank';issue.rel='noopener noreferrer';summary.append(' ',issue);
          }
          row.append(summary);
          const campaign=campaigns.get(item.id);
          if(campaign)row.append(renderCampaign(doc,campaign,create,localTime));
          else if(item.id==='MJ-REQ-292')row.append(create('p','Campaign details unavailable.','empty'));
          disclosure.append(row);
        }
        if(!items.length)disclosure.append(create('p','No requirement details are available for this priority.','empty'));
      }
      priorities.append(disclosure);
    }
    root.append(priorities);
    root.append(create('p','Overall acceptance is canonical requirement status. Campaign step receipts are scoped evidence and do not replace requirement acceptance.','caption'));
  }
  function renderCampaign(doc,campaign,create,localTime) {
    const panel=create('div',undefined,'campaign-detail');
    const issue=create('a','Open issue','issue-link');issue.href=campaign.issueUrl;issue.target='_blank';issue.rel='noopener noreferrer';
    panel.append(issue);
    panel.append(create('p','Working checkpoint: '+(campaign.sourceRevision||'Unavailable')+' ('+campaign.sourceKind+') · observed '+localTime(campaign.observedAt),'caption'));
    if(campaign.handoffRevision)panel.append(create('p','Handoff checkpoint: '+campaign.handoffRevision,'caption'));
    panel.append(create('p','Acceptance scope: '+campaign.acceptanceClaimScope,'caption'));
    panel.append(create('p','Merged acceptance: each step’s merge state is shown separately.','caption'));
    const score=campaign.scoreboard;
    panel.append(create('p',score.verifiedPass+' verified PASS · '+score.partial+' PARTIAL · '+score.notRun+' NOT_RUN · '+score.fail+' FAIL · '+score.blocked+' BLOCKED / '+score.total+' steps','campaign-score'));
    for(const phase of campaign.phases) {
      const details=create('details',undefined,'campaign-phase');
      const passed=phase.steps.filter(step=>step.status==='PASS').length;
      const partial=phase.steps.filter(step=>step.status==='PARTIAL').length;
      const notRun=phase.steps.filter(step=>step.status==='NOT_RUN').length;
      const failed=phase.steps.filter(step=>step.status==='FAIL').length;
      const blocked=phase.steps.filter(step=>step.status==='BLOCKED').length;
      details.append(create('summary',phase.label+' · '+passed+' PASS · '+partial+' PARTIAL · '+notRun+' NOT_RUN · '+failed+' FAIL · '+blocked+' BLOCKED'));
      for(const step of phase.steps) {
        const item=create('details',undefined,'campaign-step');
        item.append(create('summary','Step '+step.number+': '+step.title+' · '+step.status,'step-summary'));
        if(step.observedResult)item.append(create('p','Observed result: '+step.observedResult));
        if(step.testedCommit)item.append(create('p','Tested commit: '+step.testedCommit));
        if(step.executedAt)item.append(create('p','Executed: '+localTime(step.executedAt)));
        if(step.reviewStatus)item.append(create('p','Review state: '+step.reviewStatus));
        if(step.mergeStatus)item.append(create('p','Merged acceptance: '+step.mergeStatus));
        details.append(item);
      }
      panel.append(details);
    }
    for(const blocker of campaign.blockers||[])if(blocker)panel.append(create('p','Blocker: '+blocker,'campaign-blocker'));
    if(campaign.nextAction)panel.append(create('p','Next action: '+campaign.nextAction,'caption'));
    return panel;
  }
  function acceptanceRenderKey(model) {
    const acceptance=model.acceptance?{...model.acceptance,observedAt:null}:null;
    const campaign=model.campaignProgress;
    const campaignProgress=campaign?.available?{...campaign,observedAt:null,campaigns:campaign.campaigns.map(item=>({...item,observedAt:null}))}:campaign;
    return JSON.stringify([acceptance,campaignProgress]);
  }
  function start(doc) {
    const $ = id => doc.getElementById(id);
    const home=$('fleet-overview');
    if(home&&typeof location!=='undefined'&&['localhost','127.0.0.1'].includes(location.hostname))home.href='http://127.0.0.1:4320/';
    let last = null, failed = false, loading = false, renderedAcceptance = null;
    const control=globalThis.FleetRemoteControls?.start(doc,()=>last);
    const detail=globalThis.FleetAgentDetails?.start(doc,()=>last,control);
    const set = (id,value) => {$(id).textContent=value ?? '—';};
    const create = (tag,text,className) => {const el=doc.createElement(tag);if(text !== undefined)el.textContent=text;if(className)el.className=className;return el;};
    const localTime = value => {const date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleString():'Unknown';};
    function render() {
      const m=displayModel(last), sourceErrors=Object.values(last?.sources || {}).filter(source => !source.available).length;
      set('dispatch',m.dispatch);set('dispatch-detail',m.dispatchDetail);set('working',m.working);set('agents-detail',m.agentsDetail);
      set('verified',m.verified);set('verified-detail',m.verifiedDetail);
      set('quota',m.quota);set('quota-detail',m.quotaDetail);set('startup',m.startup);set('startup-detail',m.startupDetail);
      const acceptanceKey=acceptanceRenderKey(m);
      if(acceptanceKey!==renderedAcceptance){renderAcceptance(doc,m,create,localTime);renderedAcceptance=acceptanceKey;}
      $('dispatch').className=m.stale?'':m.dispatch==='Enabled'?'good':m.dispatch==='Blocked'?'bad':m.dispatch==='Paused'?'warn':'';
      $('freshness').className='notice '+(m.stale?'bad':failed || sourceErrors?'warn':'good');
      set('freshness',m.stale ? (last?'Status feed is stale. Current fleet activity cannot be verified. Last update: '+localTime(last.generatedAt)+'.':'Status feed is unavailable. The PC or remote monitor may be offline.') : (failed?'Refresh failed; showing the most recent snapshot. ':sourceErrors?sourceErrors+' local status source'+(sourceErrors===1?' is':'s are')+' unavailable. ':'Status feed is current. ')+(m.age ?? 0)+' seconds since publication.');
      set('updated',last?'Snapshot: '+localTime(last.generatedAt):'No snapshot received');
      set('fleet-count',m.stale?'Unknown':m.sessions.length+' agents');
      set('fleet-note',m.stale?'Current activity is unknown while the feed is stale.':last?.fleet?.preservedSnapshot?'Preserved roster · these are not live agents.':'Observed worker and controller states');
      const rows=$('agents');rows.replaceChildren();
      for(const agent of m.sessions){const row=create('tr');const name=create('td');const agentButton=create('button',agent.name || agent.id || 'Agent','agent-link');agentButton.type='button';agentButton.dataset.agentDetails=agent.id;name.append(agentButton);if(agent.id && agent.id!==agent.name)name.append(create('span',agent.id,'secondary'));row.append(name);row.append(create('td',[agent.harness,agent.model].filter(Boolean).join(' / ') || 'Unknown'));row.append(create('td',agent.role || 'Unknown'));row.append(create('td',agent.workState?.label || agent.stateLabel || agent.activity || agent.status || 'Unknown'));row.append(create('td',agent.controllerLabel || (agent.mode==='tui'?'Terminal · verification unavailable':agent.mode==='chat'?'Chat · '+(agent.controllerState||'not reported'):'Interface not reported')));rows.append(row);}
      if(!m.sessions.length){const row=create('tr'),cell=create('td',m.stale?'No fresh fleet observations available.':'No current roster available.','empty');cell.colSpan=5;row.append(cell);rows.append(row);}
      set('mission-status',!m.stale&&last?.missionControl?.available?'Current':'Unavailable');
      const lanes=$('lanes');lanes.replaceChildren();for(const lane of m.lanes){const card=create('article',undefined,'lane');card.append(create('h3',lane.id || 'Launch lane'),create('p',lane.activity || lane.status || 'Unknown','state'),create('p',[lane.model,lane.effort].filter(Boolean).join(' · ') || 'No active model'),create('p',lane.detail || 'Independent launcher observation','caption'));lanes.append(card);}
      if(!m.lanes.length)lanes.append(create('p','Launch lane telemetry is currently unavailable.'));
      detail?.refresh();control?.refresh();
      const sources=$('sources');sources.replaceChildren();for(const [name,source] of Object.entries(last?.sources || {})){const row=create('div',undefined,'source');row.append(create('span',labels[name]||name),create('span',m.stale?'Stale':source.available?'Available':source.error || 'Unavailable'));sources.append(row);}
    }
    async function refresh(){if(loading)return;loading=true;$('refresh').disabled=true;try{const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);try{const response=await fetch('./status.json',{cache:'no-store',credentials:'same-origin',signal:controller.signal});if(!response.ok)throw Error('Feed unavailable');const next=await response.json();if(next.schemaVersion!==1||next.readOnly!==true)throw Error('Unknown feed');last=next;failed=false;}finally{clearTimeout(timer);}}catch{failed=true;}finally{loading=false;$('refresh').disabled=false;render();}}
    $('refresh').addEventListener('click',refresh);doc.addEventListener('visibilitychange',()=>{if(!doc.hidden)refresh();});render();refresh();setInterval(()=>{if(!doc.hidden)refresh();},10000);setInterval(render,1000);
  }
  return { freshness, displayModel, renderAcceptance, start };
});
