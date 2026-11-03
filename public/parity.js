/* Read-only TalentHop planning evidence; independent of native fleet actions. */
(function(){
  'use strict';
  const root=document.getElementById('parity');if(!root)return;
  const node=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=String(text);return n;};
  const header=node('div'),title=node('h2','MJobs capability roadmap'),refresh=node('button','Refresh roadmap');
  refresh.type='button';header.className='parity-heading';header.append(title,refresh);
  const status=node('p','Reading GitHub evidence.'),content=node('div');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  root.append(header,status,content);
  let inFlight=false;
  const labels={PRIVATE_SITE_AUTHORIZATION_REQUIRED:'Private TalentHop access needs approval',FULL_HAR_TOOL_UNAVAILABLE:'Full HAR capture blocked',PROJECT_AUTH_SCOPE_MISSING:'GitHub Project permission missing',INTERACTIVE_COVERAGE_NOT_RUN:'Interactive journeys not exercised'};
  function link(label,url){const a=node('a',label);a.href=url;a.rel='noreferrer';return a;}
  function render(data){
    content.replaceChildren();
    if(!data.available){content.append(node('p','The current-main capability catalog could not be synchronized. No completion or deployment is inferred.'));return;}
    content.append(node('p','TalentHop parity is separate from the original P0/P1 acceptance matrix.'));
    const summary=node('p',data.features.length+' capabilities · '+data.coverage.routes.exercised+'/'+data.coverage.routes.identified+' routes exercised · '+data.coverage.journeys.exercised+'/'+data.coverage.journeys.identified+' journeys exercised · HAR '+data.harStatus);
    content.append(summary,link('Open parity epic',data.epicUrl));
    if(data.mergeWindow)content.append(node('p','Related merge search: '+data.mergeWindow.examined+' recently updated closed PRs examined'+(data.mergeWindow.complete?' (window exhausted).':' (window incomplete; older PRs may be missing).')));
    const counts=node('p',Object.entries(data.discoveryCounts).map(([name,n])=>n+' '+name.toLowerCase()).join(' · '));content.append(counts);
    content.append(node('p','Catalog implementation states: '+Object.entries(data.implementationCounts).map(([name,n])=>n+' '+name.toLowerCase()).join(' · ')+'. Delivery requires separate evidence.'));
    const blockers=node('ul');for(const code of data.blockers)blockers.append(node('li',labels[code]||'Evidence requires review'));content.append(blockers);
    const streams=node('ul');
    for(const work of data.workstreams){const li=node('li');li.append(link(work.key+' · #'+work.issue.number,work.issue.url));
      for(const claim of work.claims)li.append(node('span',' · '),link('Claim '+claim.ownerCommit.slice(0,12),claim.url),node('span',' · '+(claim.runId||'Owner run unknown')+' · '+(claim.ageIndicator==='OLDER_THAN_30_MINUTES'?'Claim older than 30 minutes; heartbeat unknown':'Claim age under 30 minutes; heartbeat unknown')));
      if(!work.claims.length)li.append(node('span',' · No matching claim at last sync'));
      for(const merged of work.relatedMerges||[])li.append(node('span',' · Related merged '),link('PR #'+merged.number,merged.url),node('span',' · commit '),link(merged.mergeSha.slice(0,12),'https://github.com/MulattoTech/MJobs/commit/'+merged.mergeSha));
      streams.append(li);}
    content.append(streams);
    const wrap=node('div'),table=node('table'),caption=node('caption','Capability evidence and current GitHub references');wrap.className='parity-table';wrap.tabIndex=0;wrap.setAttribute('aria-label','Scrollable capability table');
    table.append(caption);const head=node('thead'),headers=node('tr');
    for(const text of ['Capability','Discovery','MJobs implementation','GitHub references','Delivery evidence']){const th=node('th',text);th.scope='col';headers.append(th);}head.append(headers);table.append(head);
    const body=node('tbody');
    for(const feature of data.features){const tr=node('tr'),identity=node('td');identity.append(node('strong',feature.id+' · '+feature.title),node('div',feature.priority+(feature.dependencies.length?' · Depends on '+feature.dependencies.join(', '):'')));
      if(feature.requirements.length)identity.append(node('div','Requirements: '+feature.requirements.join(', ')));
      const references=node('td');for(const issue of feature.issues)references.append(link('#'+issue.number+' '+issue.state,issue.url),node('span',' '));
      for(const pr of feature.pulls)references.append(node('div'),link('PR #'+pr.number+' · '+pr.state+' · checks '+pr.ci.state,pr.url));
      for(const claim of feature.claims){const row=node('div');row.append(link('Claim '+claim.key,claim.url),node('span',' · '+(claim.runId||'owner unknown')+' · owner '+claim.ownerCommit.slice(0,12)+' · heartbeat unknown'));references.append(row);}
      if(feature.pulls.length>1)references.append(node('div','Multiple referenced PRs; check their scope.'));
      const delivery=node('td'),merges=feature.relatedMerges||[];
      if(merges.length){delivery.append(node('div','Related merged PRs (feature completion not inferred):'));
        for(const merged of merges)delivery.append(node('div'),link('#'+merged.number,merged.url),node('span',' · commit '),link(merged.mergeSha.slice(0,12),'https://github.com/MulattoTech/MJobs/commit/'+merged.mergeSha));}
      else delivery.append(node('div','No text-linked merge in inspected window; historical scope unknown.'));
      delivery.append(node('div','Feature delivery, deployed SHA and parity acceptance not verified.'));
      tr.append(identity,node('td',feature.discovery),node('td',feature.implementation),references,delivery);
      body.append(tr);}
    table.append(body);wrap.append(table);content.append(wrap);
    content.append(node('p','Source main: '+data.sourceSha+' · Catalog: '+data.catalogAsOf));
    content.append(node('p','PR references and reported checks do not establish protected merge or acceptance. Claim age is not a heartbeat and never permits reclaiming ownership. This panel never dispatches work.'));
  }
  async function load(manual=false){
    if(inFlight)return;inFlight=true;refresh.disabled=true;root.setAttribute('aria-busy','true');
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);
    try{const response=await fetch('/api/parity'+(manual?'?refresh=1':''),{cache:'no-store',signal:controller.signal});if(!response.ok)throw Error();
      const data=await response.json();render(data);status.textContent=(data.stale?'Stale or unavailable evidence. ':'Synchronized evidence. ')+(data.syncedAt?'Last sync '+new Date(data.syncedAt).toLocaleString()+'. ':'')+'Refreshes are rate limited.';}
    catch{status.textContent='Roadmap refresh failed. Any displayed evidence is stale; no new completion is inferred.';}
    finally{clearTimeout(timer);refresh.disabled=false;root.setAttribute('aria-busy','false');inFlight=false;}
  }
  refresh.addEventListener('click',()=>load(true));load();setInterval(()=>load(),60000);
})();
